#!/usr/bin/env node
/* Household Wealth Profiler server. Node 18+; the "pg" package only when DATABASE_URL is set.
   - Serves the app from ./public
   - Named logins (HTTP Basic over HTTPS) with scrypt-hashed passwords
   - Client files encrypted at rest with AES-256-GCM (DATA_KEY)
   - Stored as files under DATA_DIR, or in PostgreSQL when DATABASE_URL is set (db/migrations)
   - Every save is versioned; older versions are kept
   - Server-side audit trail: who changed which field, when, from what, to what
   - No delete endpoint: AML records must be kept for 5 years after the relationship ends

   Commands:
     node server.js                          start the server
     node server.js hash-password NAME PASS  print an AUTH_USERS entry
     node server.js gen-key                  print a new DATA_KEY
     node server.js import-files [DIR]       copy file-store households (DATA_DIR) into PostgreSQL

   Settings come from the environment, or from a .env file next to this one (Node 20.12+).
   Variables already set in the environment win over .env.
*/
'use strict';
const path = require('path');
const crypto = require('crypto');
const HWP = require('./packages/core/core.js');

/* ---------- CLI helpers ---------- */
const cmd = process.argv[2];
if (cmd === 'hash-password') {
  const [name, pass] = process.argv.slice(3);
  if (!name || !pass || /[:;]/.test(name)) { console.error('Usage: node server.js hash-password NAME PASSWORD (name without : or ;)'); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  console.log(`${name}:${salt}:${crypto.scryptSync(pass, salt, 64).toString('hex')}`);
  process.exit(0);
}
if (cmd === 'gen-key') { console.log(crypto.randomBytes(32).toString('base64')); process.exit(0); }

/* ---------- configuration (apps/api/src/config) ---------- */
let config;
try { config = require('./apps/api/src/config').load({ command: cmd }); }
catch (e) { console.error(e.message); process.exit(1); }
const { port: PORT, host: HOST, dataDir: DATA_DIR, databaseUrl: DATABASE_URL, clientIpHeader: CLIENT_IP_HEADER, users: USERS, key: KEY } = config;

/* ---------- encryption at rest (apps/api/src/crypto) ---------- */
const sealer = require('./apps/api/src/crypto/seal.js').createSealer(KEY);

/* ---------- storage (apps/api/src/repositories) ---------- */
const { createStore, createFileStore } = require('./apps/api/src/repositories');
let store;
try { store = createStore(config, sealer); } catch (e) { console.error(e.message); process.exit(1); }

/* ---------- households (apps/api/src/services) ---------- */
const households = require('./apps/api/src/services/households.js').createHouseholdService({ store, HWP });

/* ---------- authentication (apps/api/src/auth) ---------- */
const { authenticate } = require('./apps/api/src/auth').createAuth(config);

/* ---------- HTTP: request pipeline and routes (apps/api/src/app.js) ---------- */
const { server } = require('./apps/api/src/app.js').createApp({ config, households, authenticate });
// Copies households from a file store into PostgreSQL with their versions and audit trail
async function importFiles(dir) {
  if (!DATABASE_URL) { console.error('Set DATABASE_URL to the database to copy into.'); process.exit(1); }
  const from = createFileStore(path.resolve(dir), sealer);
  await store.init();
  let copied = 0, skipped = 0;
  for (const id of await from.ids()) {
    const versions = await from.versions(id);
    if (!versions.length) { const cur = await from.get(id); if (cur) versions.push(cur); }
    if (!versions.length) continue;
    if (await store.importHousehold(versions, (await from.audit(id)).reverse())) copied++; else skipped++;
  }
  console.log(`Copied ${copied} household(s) from ${path.resolve(dir)} (${skipped} already in the database).`);
  await store.end();
}

if (require.main === module) {
  if (cmd === 'import-files') {
    importFiles(process.argv[3] || DATA_DIR).catch(e => { console.error(e.message); process.exit(1); });
  } else {
    store.init().then(() => {
      server.listen(PORT, HOST, () => console.log(`Household Wealth Profiler on http://${HOST}:${PORT} · ${USERS.size} user(s) · encryption ${KEY ? 'on' : 'OFF'} · ${store.describe}`));
    }, e => { console.error('Could not open storage:', e.message); process.exit(1); });
  }
}
module.exports = { server };
