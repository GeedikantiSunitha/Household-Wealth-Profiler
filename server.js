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
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
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
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;

/* ---------- encryption at rest (apps/api/src/crypto) ---------- */
const sealer = require('./apps/api/src/crypto/seal.js').createSealer(KEY);

/* ---------- storage (apps/api/src/repositories) ---------- */
const { createStore, createFileStore, ID_RE } = require('./apps/api/src/repositories');
let store;
try { store = createStore(config, sealer); } catch (e) { console.error(e.message); process.exit(1); }

// One write at a time per household
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}
function summarise(rec) {
  const s = HWP.normalise(rec.state);
  let stage = '', rating = '', nextReview = '', blockers = 0, due = '', overdue = 0;
  try { const E = HWP.bind(s); const O = E.onboarding(E.compute()); stage = O.stage; rating = O.rating; nextReview = O.nextReview; blockers = O.blockerCount; const R = E.reviews(O); due = R.nextDue; overdue = R.overdue; } catch (e) { stage = 'Error'; }
  return { id: rec.id, name: s.household.name, reference: s.household.reference, stage, rating, nextReview, blockers, due, overdue, version: rec.version, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
}

/* ---------- authentication ---------- */
const failures = new Map(); // ip -> {n, until}
const authCache = new Map(); // sha256(header) -> {user, exp}
function authenticate(req) {
  const ip = (CLIENT_IP_HEADER && req.headers[CLIENT_IP_HEADER]) || req.socket.remoteAddress || '';
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return { locked: true };
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const key = crypto.createHash('sha256').update(h).digest('hex');
  const hit = authCache.get(key);
  if (hit && hit.exp > Date.now()) return { user: hit.user };
  let decoded = '';
  try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { return null; }
  const i = decoded.indexOf(':');
  const name = decoded.slice(0, i), pass = decoded.slice(i + 1);
  const u = USERS.get(name);
  const ok = !!u && i > 0 && crypto.timingSafeEqual(crypto.scryptSync(pass, u.salt, 64), u.hash);
  if (!ok) {
    const expired = f && f.until && f.until <= Date.now();
    const n = (f && !expired ? f.n : 0) + 1;
    failures.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60e3 : 0 });
    return null;
  }
  failures.delete(ip);
  authCache.set(key, { user: name, exp: Date.now() + 5 * 60e3 });
  return { user: name };
}

/* ---------- HTTP plumbing ---------- */
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
if (config.hsts) SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
// The page loads the business rules as /core.js; the one copy lives in packages/core
const CORE_FILE = path.join(__dirname, 'packages', 'core', 'core.js');
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = rel === 'core.js' ? CORE_FILE : path.resolve(PUBLIC_DIR, rel);
  if (file !== CORE_FILE && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) { send(res, 404, { error: 'Not found' }); }
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/healthz') return send(res, 200, { ok: true });
  const auth = authenticate(req);
  if (!auth || auth.locked) {
    return send(res, auth && auth.locked ? 429 : 401, { error: auth && auth.locked ? 'Too many failed sign-ins. Try again in 15 minutes.' : 'Sign in required' },
      auth && auth.locked ? {} : { 'WWW-Authenticate': 'Basic realm="Household Wealth Profiler", charset="UTF-8"' });
  }
  const user = auth.user;
  if (!p.startsWith('/api/')) return req.method === 'GET' ? serveStatic(req, res, p) : send(res, 405, { error: 'Method not allowed' });

  // Mutating calls must come from this site (CSRF protection for Basic auth)
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (origin && new URL(origin).host !== host) return send(res, 403, { error: 'Cross-site request refused' });
    if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'Send JSON' });
  }

  if (p === '/api/me' && req.method === 'GET') return send(res, 200, { user, encrypted: !!KEY });

  if (p === '/api/households' && req.method === 'GET') {
    const list = (await store.list()).map(summarise);
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return send(res, 200, list);
  }
  if (p === '/api/households' && req.method === 'POST') {
    const body = await readBody(req);
    const state = HWP.normalise(body.state);
    delete state.audit;
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), version: 1, state, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
    await withLock(rec.id, () => store.create(rec, [{ ts: now, user, field: 'created', from: '', to: state.household.name || '' }]));
    return send(res, 201, { id: rec.id, version: rec.version });
  }
  const m = /^\/api\/households\/([^/]+)(\/audit)?$/.exec(p);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return send(res, 404, { error: 'Not found' });
    if (m[2] && req.method === 'GET') {
      if (!(await store.get(id))) return send(res, 404, { error: 'Not found' });
      return send(res, 200, (await store.audit(id)).slice(0, 5000));
    }
    if (!m[2] && req.method === 'GET') {
      const rec = await store.get(id);
      return rec ? send(res, 200, rec) : send(res, 404, { error: 'Not found' });
    }
    if (!m[2] && req.method === 'PUT') {
      const body = await readBody(req);
      const [status, out] = await withLock(id, () => store.update(id, rec => {
        if (!rec) return { result: [404, { error: 'Not found' }] };
        if (+body.version !== rec.version) return { result: [409, { error: 'This household was changed by someone else', version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt }] };
        const state = HWP.normalise(body.state);
        delete state.audit;
        const now = new Date().toISOString();
        const changes = HWP.diff(rec.state, state).map(c => ({ ts: now, user, ...c, version: rec.version + 1 }));
        if (!changes.length) return { result: [200, { version: rec.version, changes: 0 }] };
        const next = { ...rec, version: rec.version + 1, state, updatedAt: now, updatedBy: user };
        return { next, audit: changes, result: [200, { version: next.version, changes: changes.length }] };
      }));
      return send(res, status, out);
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, req.url, err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message });
  });
});
server.headersTimeout = 20e3;
server.requestTimeout = 30e3;
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
