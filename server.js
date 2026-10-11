#!/usr/bin/env node
/* Household Wealth Profiler server. No dependencies: Node 18+ only.
   - Serves the app from ./public
   - Named logins (HTTP Basic over HTTPS) with scrypt-hashed passwords
   - Client files encrypted at rest with AES-256-GCM (DATA_KEY)
   - Every save is versioned; older versions are kept
   - Server-side audit trail: who changed which field, when, from what, to what
   - No delete endpoint: AML records must be kept for 5 years after the relationship ends

   Commands:
     node server.js                          start the server
     node server.js hash-password NAME PASS  print an AUTH_USERS entry
     node server.js gen-key                  print a new DATA_KEY
*/
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const HWP = require('./public/core.js');

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
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
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
if (!USERS.size) { console.error('No users configured. Set AUTH_USERS (run: node server.js hash-password NAME PASSWORD).'); process.exit(1); }
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
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hhDir = id => path.join(DATA_DIR, 'households', id);
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
async function readAudit(id) {
  let text = '';
  try { text = await fsp.readFile(path.join(hhDir(id), 'audit.log'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return text.split('\n').filter(Boolean).map(l => JSON.parse(open(l))).reverse();
}
// Optional monthly price history for exchange-listed funds from Alpha Vantage (free key). Set ALPHAVANTAGE_KEY to enable.
const AV_KEY = process.env.ALPHAVANTAGE_KEY || '';
const priceCache = new Map(); // symbol -> {at, text}
async function fetchPrices(symbol) {
  const hit = priceCache.get(symbol);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.text;
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&datatype=csv&apikey=${encodeURIComponent(AV_KEY)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok || !/^timestamp,/i.test(text)) {
    const msg = /Invalid API call/i.test(text) ? 'The data provider does not recognise that ticker. Try the exchange suffix, e.g. VWRL.LON.' : /rate limit|frequency|premium/i.test(text) ? 'The free data allowance for today is used up. Try again tomorrow or import a CSV.' : 'The data provider did not return prices.';
    throw Object.assign(new Error(msg), { status: 502 });
  }
  priceCache.set(symbol, { at: Date.now(), text });
  return text;
}
// Firm settings: one record for the firm (details, team, providers), versioned and audited like a household
const firmDir = () => hhDir('firm'); // beside the households; the list only reads UUID folders
async function readFirm() {
  try { return JSON.parse(open(await fsp.readFile(path.join(firmDir(), 'current.json'), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return { version: 0, settings: HWP.firmBlank(), updatedAt: '', updatedBy: '' }; throw e; }
}
async function writeFirm(rec) {
  const text = seal(JSON.stringify(rec));
  await writeAtomic(path.join(firmDir(), 'versions', `${String(rec.version).padStart(6, '0')}.json`), text);
  await writeAtomic(path.join(firmDir(), 'current.json'), text);
}
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
  return { id: rec.id, name: s.household.name, reference: s.household.reference, stage, rating, nextReview, blockers, due, overdue, tasks: HWP.openTasks(s), version: rec.version, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
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
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
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

  if (p === '/api/firm' && req.method === 'GET') return send(res, 200, await readFirm());
  if (p === '/api/prices' && req.method === 'GET') {
    if (!AV_KEY) return send(res, 501, { error: 'Automatic prices are not set up. Ask your administrator to add an Alpha Vantage key, or import a CSV.' });
    const symbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(symbol)) return send(res, 400, { error: 'Enter an exchange ticker such as VWRL.LON' });
    return send(res, 200, { symbol, csv: await fetchPrices(symbol) });
  }
  if (p === '/api/firm/audit' && req.method === 'GET') return send(res, 200, (await readAudit('firm')).slice(0, 5000));
  if (p === '/api/firm' && req.method === 'PUT') {
    const body = await readBody(req);
    return withLock('firm', async () => {
      const rec = await readFirm();
      if (+body.version !== rec.version) return send(res, 409, { error: 'Firm settings were changed by someone else', version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt });
      const settings = HWP.firmNormalise(body.settings);
      const now = new Date().toISOString();
      const changes = HWP.firmDiff(rec.settings, settings).map(c => ({ ts: now, user, ...c, version: rec.version + 1 }));
      if (!changes.length) return send(res, 200, { version: rec.version, changes: 0 });
      const next = { version: rec.version + 1, settings, updatedAt: now, updatedBy: user };
      await writeFirm(next);
      await appendAudit('firm', changes);
      return send(res, 200, { version: next.version, changes: changes.length });
    });
  }

  if (p === '/api/households' && req.method === 'GET') {
    let ids = [];
    try { ids = (await fsp.readdir(path.join(DATA_DIR, 'households'))).filter(x => ID_RE.test(x)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const list = [];
    for (const id of ids) { const rec = await readRecord(id); if (rec) list.push(summarise(rec)); }
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return send(res, 200, list);
  }
  if (p === '/api/households' && req.method === 'POST') {
    const body = await readBody(req);
    const state = HWP.normalise(body.state);
    delete state.audit;
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), version: 1, state, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
    await withLock(rec.id, async () => {
      await writeRecord(rec);
      await appendAudit(rec.id, [{ ts: now, user, field: 'created', from: '', to: state.household.name || '' }]);
    });
    return send(res, 201, { id: rec.id, version: rec.version });
  }
  const m = /^\/api\/households\/([^/]+)(\/audit)?$/.exec(p);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return send(res, 404, { error: 'Not found' });
    if (m[2] && req.method === 'GET') {
      if (!(await readRecord(id))) return send(res, 404, { error: 'Not found' });
      return send(res, 200, (await readAudit(id)).slice(0, 5000));
    }
    if (!m[2] && req.method === 'GET') {
      const rec = await readRecord(id);
      return rec ? send(res, 200, rec) : send(res, 404, { error: 'Not found' });
    }
    if (!m[2] && req.method === 'PUT') {
      const body = await readBody(req);
      return withLock(id, async () => {
        const rec = await readRecord(id);
        if (!rec) return send(res, 404, { error: 'Not found' });
        if (+body.version !== rec.version) return send(res, 409, { error: 'This household was changed by someone else', version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt });
        const state = HWP.normalise(body.state);
        delete state.audit;
        const now = new Date().toISOString();
        const changes = HWP.diff(rec.state, state).map(c => ({ ts: now, user, ...c, version: rec.version + 1 }));
        if (!changes.length) return send(res, 200, { version: rec.version, changes: 0 });
        const next = { ...rec, version: rec.version + 1, state, updatedAt: now, updatedBy: user };
        await writeRecord(next);
        await appendAudit(id, changes);
        return send(res, 200, { version: next.version, changes: changes.length });
      });
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
if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  server.listen(PORT, HOST, () => console.log(`Household Wealth Profiler on http://${HOST}:${PORT} · ${USERS.size} user(s) · encryption ${KEY ? 'on' : 'OFF'} · data in ${DATA_DIR}`));
}
module.exports = { server };
