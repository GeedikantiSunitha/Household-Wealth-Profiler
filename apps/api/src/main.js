/* Start-up: puts the layers together and runs a command or the server. `node server.js …` calls
   main(args). The order matters:
     1. commands that need no settings (hash-password, gen-key)
     2. settings (stop with a message when one is missing or wrong)
     3. encryption, storage, the household service, sign-in, the request pipeline
     4. a data command (import-files, migrate, index-references, rotate-key, check-records, create-user,
        set-password), or prepare storage and start
        listening. Development applies new migrations itself; production only checks none is
        pending and refuses to start otherwise (migrations are run as the owner: node server.js
        migrate with DATABASE_OWNER_URL).
   Any other first argument starts the server, as before.
   On SIGTERM or SIGINT (the host stopping the container, Ctrl-C) the server stops taking new
   connections, lets requests in flight finish, closes storage and exits 0; if that takes longer
   than 10 seconds it exits 1. */
'use strict';
const path = require('path');
const HWP = require('../../../packages/core/core.js');
const { load } = require('./config');
const { createSealer } = require('./crypto/seal.js');
const { createStore, DEFAULT_FIRM_ID } = require('./repositories');
const { migrateWith } = require('./db/pool.js');
const { createHouseholdService } = require('./services/households.js');
const { createFirmService } = require('./services/firm.js');
const { createMemberService } = require('./services/members.js');
const { createPriceService } = require('./services/prices.js');
const { createAuth } = require('./auth');
const { createAuthStore } = require('./auth/store.js');
const { createSessions, sessionSecretFrom } = require('./auth/sessions.js');
const { createLimiter, AUTH_LIMIT } = require('./auth/limiter.js');
const { dummyHashString } = require('./auth/password.js');
const { createAuthRoutes } = require('./routes/auth.js');
const { createMailer } = require('./auth/mail.js');
const { createNotify } = require('./auth/notify.js');
const { createApp } = require('./app.js');
const { hashPasswordCommand, genKeyCommand } = require('./cli');
const { importFiles } = require('./cli/import-files.js');
const { rotateKey } = require('./cli/rotate-key.js');
const { checkRecords } = require('./cli/check-records.js');
const { createUser, setPassword } = require('./cli/accounts.js');
const platform = require('./cli/platform.js');

const STOP_TIMEOUT_MS = 10e3;

function stopOnSignal(server, store) {
  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    console.log(new Date().toISOString(), `${signal}: stopping; requests in flight are finishing`);
    const force = setTimeout(() => { console.error(new Date().toISOString(), 'stop timed out'); process.exit(1); }, STOP_TIMEOUT_MS);
    // Connections that finish their request while stopping become idle and are closed on the next sweep
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    server.close(async () => {
      clearInterval(sweep);
      try { if (store.end) await store.end(); } catch (e) { console.error(new Date().toISOString(), 'closing storage:', e.message); }
      clearTimeout(force);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

function main([cmd, ...args] = []) {
  if (cmd === 'hash-password') process.exit(hashPasswordCommand(args));
  if (cmd === 'gen-key') process.exit(genKeyCommand());

  let config;
  try { config = load({ command: cmd }); } catch (e) { console.error(e.message); process.exit(1); }
  if (cmd === 'migrate') {
    const url = config.databaseOwnerUrl || config.databaseUrl;
    if (!url) { console.error('Set DATABASE_OWNER_URL (or DATABASE_URL) to the database to migrate.'); process.exit(1); }
    migrateWith(url, path.join(config.root, 'db', 'migrations'))
      .then(done => { console.log(done.length ? `Applied ${done.length} migration(s): ${done.join(', ')}` : 'No migrations pending.'); }, e => { console.error(e.message); process.exit(1); });
    return;
  }
  if (cmd === 'rotate-key') {
    rotateKey({ ownerUrl: config.databaseOwnerUrl || config.databaseUrl, key: config.key, newKey: config.newKey })
      .then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });
    return;
  }
  if (cmd === 'grant-operator') {
    platform.grantOperator({ ownerUrl: config.databaseOwnerUrl })
      .then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });
    return;
  }
  // Operator commands run as the operator role, which cannot read client records (db/operator.sql).
  // In production there is no fallback; in development without the role they run as the owner, with a note.
  const OPERATOR_RUN = { 'create-user': a => createUser({ ownerUrl: a.url, args: a.args }), 'set-password': a => setPassword({ ownerUrl: a.url, args: a.args }),
    'firm-create': platform.createFirm, 'firm-list': platform.listFirms, 'firm-seats': platform.setSeats, 'firm-status': platform.setStatus, 'access-review': platform.accessReview };
  if (OPERATOR_RUN[cmd]) {
    let url = config.databaseOperatorUrl;
    if (!url && config.production) { console.error('Set DATABASE_OPERATOR_URL: in production the operator commands run as the operator role, which cannot read client records (README, "The platform operator").'); process.exit(1); }
    if (!url) { url = config.databaseOwnerUrl || config.databaseUrl; console.error('Note: DATABASE_OPERATOR_URL is not set, so this runs as the database owner, which can read the encrypted client records. Set up the operator role for production (README).'); }
    OPERATOR_RUN[cmd]({ url, args })
      .then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });
    return;
  }
  const sealer = createSealer(config.key);
  let store;
  try { store = createStore(config, sealer); } catch (e) { console.error(e.message); process.exit(1); }
  const households = createHouseholdService({ store, HWP, production: config.production });
  const firm = createFirmService({ store, HWP });
  const prices = createPriceService({ key: config.alphavantageKey });
  // The app's own sign-in needs PostgreSQL (sessions, accounts); with files, Basic sign-in is the only way in
  const authStore = store.pool ? createAuthStore({ pool: store.pool }) : null;
  const sessions = authStore ? createSessions({ store: authStore, secret: sessionSecretFrom(config.key), idleMs: config.sessionIdleMinutes * 60e3, absoluteMs: config.sessionAbsoluteHours * 3600e3, secure: config.secureCookies }) : null;
  const { authenticate } = createAuth(config, { authStore, sessions });
  // The sign-in emails: links, warnings, access requests (to the log outside production when SMTP_URL is not set)
  const mailer = createMailer({ smtpUrl: config.smtpUrl, from: config.smtpFrom, production: config.production });
  const notify = createNotify({ mailer, publicUrl: config.publicUrl || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`, operatorEmail: config.operatorEmail });
  const authRoutes = authStore ? createAuthRoutes({ authStore, sessions, limiter: createLimiter(AUTH_LIMIT), notify, clientIpHeader: config.clientIpHeader, sealer, issuer: 'Household Wealth Profiler' }) : null;
  const members = authStore ? createMemberService({ authStore, notify }) : null;
  const { server } = createApp({ config, households, firm, prices, authenticate, authRoutes, members, ready: () => store.ready() });

  if (cmd === 'import-files') {
    importFiles({ dir: args[0] || config.dataDir, databaseUrl: config.databaseUrl, store, sealer })
      .then(code => { if (code) process.exit(code); }, e => { console.error(e.message); process.exit(1); });
    return;
  }
  if (cmd === 'index-references') {
    if (!config.databaseUrl) { console.error('Set DATABASE_URL to the database whose reference index to fill.'); process.exit(1); }
    const firmId = args[0] || DEFAULT_FIRM_ID;
    store.forFirm(firmId).reindexReferences()
      .then(async n => { console.log(`${n} household(s) indexed for firm ${firmId}.`); await store.end(); }, async e => { console.error(e.message); await store.end().catch(() => {}); process.exit(1); });
    return;
  }
  if (cmd === 'check-records') {
    checkRecords({ store, H: HWP, dataDir: config.dataDir, databaseUrl: config.databaseUrl, ownerUrl: config.databaseOwnerUrl, firmId: args[0] })
      .then(async code => { if (store.end) await store.end(); process.exit(code); }, async e => { console.error(e.message); if (store.end) await store.end().catch(() => {}); process.exit(1); });
    return;
  }
  if (authStore) dummyHashString().catch(() => {}); // warm: the first unknown-email sign-in then costs the same as any other
  store.init().then(() => {
    stopOnSignal(server, store);
    server.listen(config.port, config.host, () => console.log(`Household Wealth Profiler on http://${config.host}:${config.port} · ${config.users.size} user(s) · encryption ${config.key ? 'on' : 'OFF'} · ${store.describe}${config.production ? ' · production' : ''}`));
  }, e => { console.error('Could not open storage:', e.message); process.exit(1); });
  return server;
}

module.exports = { main };
