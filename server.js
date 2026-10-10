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

/* ---------- configuration ---------- */
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_FILE);
  else console.warn('.env found but this Node version cannot read it (needs 20.12+). Set the variables in the environment instead.');
}
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATABASE_URL = process.env.DATABASE_URL || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;
// Behind a hosting proxy every connection comes from the proxy. Name the header the proxy sets
// to the real client address (Fly.io: fly-client-ip). Only set this when the proxy overwrites it.
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || '').toLowerCase();
const USERS = new Map();
for (const entry of (process.env.AUTH_USERS || '').split(';').map(s => s.trim()).filter(Boolean)) {
  const [name, salt, hash] = entry.split(':');
  if (name && salt && hash) USERS.set(name, { salt, hash: Buffer.from(hash, 'hex') });
}
let KEY = null;
if (process.env.DATA_KEY) {
  KEY = Buffer.from(process.env.DATA_KEY, 'base64');
  if (KEY.length !== 32) { console.error('DATA_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key'); process.exit(1); }
}
if (!USERS.size && cmd !== 'import-files') { console.error('No users configured. Set AUTH_USERS (run: node server.js hash-password NAME PASSWORD).'); process.exit(1); }
if (!KEY && process.env.ALLOW_PLAINTEXT !== '1') { console.error('DATA_KEY is not set. Client data would be stored unencrypted. Set DATA_KEY, or ALLOW_PLAINTEXT=1 for local testing only.'); process.exit(1); }

/* ---------- encryption at rest ---------- */
function seal(text) {
  if (!KEY) return text;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function open(text) {
  if (!text.startsWith('enc:v1:')) return text;
  if (!KEY) throw new Error('Data is encrypted but DATA_KEY is not set');
  const raw = Buffer.from(text.slice(7), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/* ---------- storage ---------- */
// Two stores with the same shape. Records and audit entries are sealed (encrypted when DATA_KEY
// is set) before they reach the disk or the database.
//   list()               every current record
//   get(id)              current record or null
//   create(rec, audit)   new household at version 1
//   update(id, decide)   decide(current) returns { result, next?, audit? }; when next is given it is
//                        saved as the new version together with its audit entries, atomically
//   audit(id)            audit entries, newest first
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fileStore(dir) {
  const hhDir = id => path.join(dir, 'households', id);
  async function writeAtomic(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }
  async function readRecord(id) {
    try { return JSON.parse(open(await fsp.readFile(path.join(hhDir(id), 'current.json'), 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function writeRecord(rec) {
    const text = seal(JSON.stringify(rec));
    await writeAtomic(path.join(hhDir(rec.id), 'versions', `${String(rec.version).padStart(6, '0')}.json`), text);
    await writeAtomic(path.join(hhDir(rec.id), 'current.json'), text);
  }
  async function appendAudit(id, entries) {
    if (!entries.length) return;
    const lines = entries.map(e => seal(JSON.stringify(e)) + '\n').join('');
    await fsp.mkdir(hhDir(id), { recursive: true, mode: 0o700 });
    await fsp.appendFile(path.join(hhDir(id), 'audit.log'), lines, { mode: 0o600 });
  }
  async function ids() {
    try { return (await fsp.readdir(path.join(dir, 'households'))).filter(x => ID_RE.test(x)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  return {
    describe: 'data in ' + dir,
    async init() { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
    ids,
    async list() { const out = []; for (const id of await ids()) { const rec = await readRecord(id); if (rec) out.push(rec); } return out; },
    get: readRecord,
    async versions(id) {
      let names = [];
      try { names = (await fsp.readdir(path.join(hhDir(id), 'versions'))).filter(f => /^\d+\.json$/.test(f)).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const out = [];
      for (const f of names) out.push(JSON.parse(open(await fsp.readFile(path.join(hhDir(id), 'versions', f), 'utf8'))));
      return out;
    },
    async create(rec, audit) { await writeRecord(rec); await appendAudit(rec.id, audit); },
    async update(id, decide) {
      const out = await decide(await readRecord(id));
      if (out.next) { await writeRecord(out.next); await appendAudit(id, out.audit || []); }
      return out.result;
    },
    async audit(id) {
      let text = '';
      try { text = await fsp.readFile(path.join(hhDir(id), 'audit.log'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return text.split('\n').filter(Boolean).map(l => JSON.parse(open(l))).reverse();
    },
  };
}

function pgStore(url) {
  let pg;
  try { pg = require('pg'); } catch (e) { console.error('DATABASE_URL is set but the "pg" package is missing. Run: npm install'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url, max: +process.env.DATABASE_POOL_MAX || 10 });
  pool.on('error', err => console.error(new Date().toISOString(), 'database connection error', err.message));
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
    catch (e) { await c.query('rollback').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  const sealAll = entries => entries.map(e => seal(JSON.stringify(e)));
  async function insertVersion(c, rec, audit) {
    const doc = seal(JSON.stringify(rec));
    await c.query('insert into household_versions (household_id, version, doc, saved_at) values ($1, $2, $3, $4)', [rec.id, rec.version, doc, rec.updatedAt]);
    if (audit.length) await c.query('insert into audit_log (household_id, entry) select $1, unnest($2::text[])', [rec.id, sealAll(audit)]);
    return doc;
  }
  let where = 'PostgreSQL';
  try { const u = new URL(url); where = `PostgreSQL ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch (e) {}
  return {
    describe: 'data in ' + where,
    // Applies any new db/migrations files; several processes starting at once take turns
    async init() {
      const { migrate, pgClient } = require('./db/migrate.js');
      const c = await pool.connect();
      try { await migrate(pgClient(c), { dir: path.join(__dirname, 'db', 'migrations'), log: m => console.log(new Date().toISOString(), m) }); }
      finally { c.release(); }
    },
    async list() { return (await pool.query('select doc from households')).rows.map(r => JSON.parse(open(r.doc))); },
    async get(id) { const r = (await pool.query('select doc from households where id = $1', [id])).rows[0]; return r ? JSON.parse(open(r.doc)) : null; },
    async create(rec, audit) {
      await tx(async c => {
        const doc = seal(JSON.stringify(rec));
        await c.query('insert into households (id, version, doc, updated_at) values ($1, $2, $3, $4)', [rec.id, rec.version, doc, rec.updatedAt]);
        await insertVersion(c, rec, audit);
      });
    },
    // The row lock (select ... for update) serialises saves across every server process
    async update(id, decide) {
      return tx(async c => {
        const r = (await c.query('select doc from households where id = $1 for update', [id])).rows[0];
        const out = await decide(r ? JSON.parse(open(r.doc)) : null);
        if (out.next) {
          const doc = await insertVersion(c, out.next, out.audit || []);
          await c.query('update households set version = $2, doc = $3, updated_at = $4 where id = $1', [id, out.next.version, doc, out.next.updatedAt]);
        }
        return out.result;
      });
    },
    async audit(id) { return (await pool.query('select entry from audit_log where household_id = $1 order by id desc', [id])).rows.map(r => JSON.parse(open(r.entry))); },
    // import-files: copies one household's whole history; false when it is already there
    async importHousehold(versions, audit) {
      const last = versions[versions.length - 1];
      return tx(async c => {
        if ((await c.query('select 1 from households where id = $1', [last.id])).rows.length) return false;
        await c.query('insert into households (id, version, doc, updated_at) values ($1, $2, $3, $4)', [last.id, last.version, seal(JSON.stringify(last)), last.updatedAt]);
        for (const v of versions) await insertVersion(c, v, []);
        if (audit.length) await c.query('insert into audit_log (household_id, entry) select $1, unnest($2::text[])', [last.id, sealAll(audit)]);
        return true;
      });
    },
    end: () => pool.end(),
  };
}

const store = DATABASE_URL ? pgStore(DATABASE_URL) : fileStore(DATA_DIR);

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
if (process.env.HSTS !== '0') SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
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
  const from = fileStore(path.resolve(dir));
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
