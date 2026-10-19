// The split-address mode (FRONTEND_ORIGIN): the front end and the back end on different addresses,
// as in the ModelMyWealth and mahimapareek deployments. Nothing here changes the default, one
// address with the web tier passing /api/ along: with no FRONTEND_ORIGIN every test below that
// needs the allowlist is skipped by construction and the existing suites cover the default.
//   - the cors gate answers a preflight and marks replies for an allowed origin, never "*"
//   - a write from an allowed origin passes the same-site gate, a foreign origin does not, and the
//     old same-host rule still holds
//   - the session cookie carries the SameSite the settings ask for (None only with Secure)
//   - the settings are validated: https only in production, no wildcard, no path
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCors, CORS_HEADERS } = require('../../src/middleware/cors.js');
const mw = require('../../src/middleware');
const { createSessions } = require('../../src/services/auth/sessions.js');
const { load } = require('../../src/config');
const { createApp } = require('../../src/app.js');

const FRONT = 'https://app.example.com';
const OTHER = 'https://evil.example.com';

const fakeRes = () => { const r = { headers: {}, status: null, ended: false, setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, writeHead(s, h = {}) { r.status = s; for (const [k, v] of Object.entries(h)) r.headers[k.toLowerCase()] = v; }, end() { r.ended = true; } }; return r; };
const gate = (origins, method, origin, p = '/api/households') => {
  const res = fakeRes(); const ctx = { req: { method, headers: origin ? { origin } : {} }, res, p };
  return { handled: createCors({ origins })(ctx), res };
};

test('the cors gate: an allowed origin gets its own address back with credentials, never "*"; a preflight is answered 204 with the methods and headers the app uses', () => {
  const get = gate([FRONT], 'GET', FRONT);
  assert.equal(get.handled, false, 'a real request goes on to the other gates');
  assert.equal(get.res.headers['access-control-allow-origin'], FRONT);
  assert.equal(get.res.headers['access-control-allow-credentials'], 'true');
  assert.match(get.res.headers.vary, /Origin/);
  const pre = gate([FRONT], 'OPTIONS', FRONT);
  assert.equal(pre.handled, true); assert.equal(pre.res.status, 204); assert.ok(pre.res.ended);
  assert.equal(pre.res.headers['access-control-allow-origin'], FRONT);
  assert.equal(pre.res.headers['access-control-allow-methods'], 'GET, POST, PUT, PATCH, OPTIONS');
  for (const h of ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key']) assert.ok(pre.res.headers['access-control-allow-headers'].split(', ').includes(h), h);
  assert.equal(CORS_HEADERS.length, 4);
  assert.notEqual(pre.res.headers['access-control-allow-origin'], '*');
});

test('the cors gate: a foreign or missing origin gets no CORS header at all, and does nothing when there is no allowlist (the default, one address)', () => {
  for (const [origins, method, origin] of [[[FRONT], 'GET', OTHER], [[FRONT], 'OPTIONS', OTHER], [[FRONT], 'GET', undefined], [[FRONT], 'GET', 'null'], [[], 'GET', FRONT], [[], 'OPTIONS', FRONT]]) {
    const r = gate(origins, method, origin);
    assert.equal(r.handled, false, `${origins.length} origins, ${method} from ${origin}`);
    assert.equal(r.res.headers['access-control-allow-origin'], undefined);
    assert.equal(r.res.status, null);
  }
  const notApi = gate([FRONT], 'OPTIONS', FRONT, '/index.html');
  assert.equal(notApi.handled, false, 'a preflight is answered for /api/ only');
});

test('the same-site gate with an allowlist: an allowed Origin passes, a foreign one is 403 cross_site, the old same-host rule still passes, no Origin still passes to the other checks', () => {
  const write = (origin, host = 'api.example.com') => ({ method: 'POST', headers: { host, ...(origin ? { origin } : {}) } });
  assert.equal(mw.checkSameSite(write(FRONT), [FRONT]), null);
  assert.equal(mw.checkSameSite(write(FRONT.toUpperCase() === FRONT ? FRONT : FRONT), [FRONT]), null);
  assert.equal(mw.checkSameSite(write(OTHER), [FRONT])[0], 403);
  assert.equal(mw.checkSameSite(write('null'), [FRONT])[0], 403);
  assert.equal(mw.checkSameSite(write('https://api.example.com'), [FRONT]), null, 'the back end\'s own pages still work');
  assert.equal(mw.checkSameSite(write(undefined), [FRONT]), null);
  assert.equal(mw.checkSameSite(write(FRONT), []) && mw.checkSameSite(write(FRONT), [])[0], 403, 'without an allowlist the front end\'s address is a foreign site, as today');
  assert.equal(mw.checkWrite({ method: 'POST', headers: { host: 'api.example.com', origin: FRONT } }, [FRONT])[0], 415, 'the JSON check follows the same-site check');
  assert.equal(mw.checkWrite({ method: 'POST', headers: { host: 'api.example.com', origin: OTHER, 'content-type': 'application/json' } }, [FRONT])[0], 403);
});

test('the gates: eleven, cors second after health, in the fixed order', () => {
  assert.deepEqual([...mw.ORDER], ['parse-url', 'health', 'cors', 'api-only', 'authenticate', 'sign-in-required', 'second-step', 'firm-required', 'same-site', 'json-body', 'csrf']);
});

test('the session cookie: SameSite=Strict by default; None only together with Secure; Lax or Strict when asked', () => {
  const make = opts => createSessions({ store: {}, secret: crypto.randomBytes(32), now: () => 0, ...opts });
  const attrs = c => c.split('; ').slice(2).join('; ');
  assert.match(make({ secure: true }).clearCookie(), /^__Host-hwp_session=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Strict$/, 'the default is unchanged');
  assert.match(make({ secure: true, sameSite: 'None' }).clearCookie(), /^__Host-hwp_session=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=None$/);
  assert.match(make({ secure: true, sameSite: 'Lax' }).clearCookie(), /SameSite=Lax$/);
  assert.throws(() => make({ secure: false, sameSite: 'None' }), /SameSite=None needs a Secure cookie/);
  assert.match(make({ secure: false }).clearCookie(), /^hwp_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict$/, 'plain development cookie unchanged');
  assert.equal(attrs('a=b; Max-Age=0; Path=/; HttpOnly'), 'Path=/; HttpOnly');
});

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-cors-'));
const KEY = crypto.randomBytes(32).toString('base64');
const prod = (extra = {}) => load({ env: { NODE_ENV: 'production', DATA_KEY: KEY, DATABASE_URL: 'postgres://x', PUBLIC_URL: FRONT, SMTP_URL: 'smtps://u:p@mail.example.com', ...extra }, root: root() });
const dev = (extra = {}) => load({ env: { DATA_KEY: KEY, DATABASE_URL: 'postgres://x', ...extra }, root: root() });

test('settings: FRONTEND_ORIGIN is a comma-separated list of origins; none means one address; SESSION_SAMESITE defaults to None only when an origin is allowed over HTTPS', () => {
  assert.deepEqual(prod().frontendOrigins, [], 'unset: the default, one address');
  assert.equal(prod().sessionSameSite, 'Strict');
  const c = prod({ FRONTEND_ORIGIN: ' https://App.Example.com/ , https://other.example.org ' });
  assert.deepEqual(c.frontendOrigins, ['https://app.example.com', 'https://other.example.org'], 'trimmed, lower case, no trailing slash');
  assert.equal(c.sessionSameSite, 'None');
  assert.equal(prod({ FRONTEND_ORIGIN: FRONT, SESSION_SAMESITE: 'strict' }).sessionSameSite, 'Strict', 'the same registrable domain keeps Strict');
  assert.equal(prod({ FRONTEND_ORIGIN: FRONT, SESSION_SAMESITE: 'lax' }).sessionSameSite, 'Lax');
  assert.equal(dev({ FRONTEND_ORIGIN: 'http://localhost:5173' }).sessionSameSite, 'Strict', 'two ports on localhost are one site: Strict works, and None would need Secure');
  assert.deepEqual(dev({ FRONTEND_ORIGIN: 'http://localhost:5173' }).frontendOrigins, ['http://localhost:5173']);
});

test('settings: refusals name the setting; production takes https only; no wildcard, no path, no empty entry', () => {
  for (const bad of ['*', 'https://*.example.com', 'https://app.example.com/path', 'app.example.com', 'https://app.example.com,,https://b.example.com', 'ftp://app.example.com']) {
    assert.throws(() => prod({ FRONTEND_ORIGIN: bad }), /FRONTEND_ORIGIN/, bad);
  }
  assert.throws(() => prod({ FRONTEND_ORIGIN: 'http://app.example.com' }), /FRONTEND_ORIGIN: production takes https origins only/);
  assert.throws(() => dev({ SESSION_SAMESITE: 'sometimes' }), /SESSION_SAMESITE must be strict, lax or none/);
  assert.throws(() => dev({ FRONTEND_ORIGIN: 'http://localhost:5173', SESSION_SAMESITE: 'none' }), /SESSION_SAMESITE=none needs an https PUBLIC_URL/);
});

test('over HTTP: an allowed origin\'s preflight and write reach the app; a foreign origin\'s do not; the reply carries the origin and credentials headers on errors too', async () => {
  const calls = [];
  const households = { list: async ctx => { calls.push('list'); return []; }, create: async () => ({ id: '0', version: 1 }), get: async () => null, audit: async () => null, save: async () => ({ notFound: true }) };
  const { server } = createApp({
    config: { hsts: false, key: Buffer.alloc(32), root: path.join(__dirname, '..', '..', '..'), users: new Map(), serveWeb: false, frontendOrigins: [FRONT] },
    households, firm: { get: async () => ({}), audit: async () => [], save: async () => ({}) }, prices: { enabled: false },
    authenticate: req => (req.headers.authorization === 'ok' ? { user: 'sam', firmId: 'f1a00000-0000-4000-8000-000000000001' } : null), ready: async () => {},
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const at = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(at + '/api/households', { method: 'OPTIONS', headers: { Origin: FRONT, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), FRONT); assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    r = await fetch(at + '/api/households', { method: 'OPTIONS', headers: { Origin: OTHER } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'a foreign origin gets nothing to read the reply with');
    r = await fetch(at + '/api/households', { headers: { Origin: FRONT } });
    assert.equal(r.status, 401); assert.equal(r.headers.get('access-control-allow-origin'), FRONT, 'even a refusal is readable by the allowed front end, so it can show the sign-in');
    r = await fetch(at + '/api/households', { headers: { Origin: FRONT, Authorization: 'ok' } });
    assert.equal(r.status, 200); assert.deepEqual(calls, ['list']);
    r = await fetch(at + '/api/households', { method: 'POST', headers: { Origin: OTHER, Authorization: 'ok', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403); assert.equal((await r.json()).code, 'cross_site'); assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(at + '/api/households', { method: 'POST', headers: { Origin: FRONT, Authorization: 'ok', 'Content-Type': 'application/json' }, body: JSON.stringify({ state: {} }) });
    assert.notEqual(r.status, 403, 'the allowed origin\'s write passes the same-site gate');
    r = await fetch(at + '/index.html', { headers: { Origin: FRONT } });
    assert.equal(r.status, 404, 'the back end serves no screens in this mode');
  } finally { server.close(); }
});
