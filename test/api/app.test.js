// apps/api/src/app.js: the order every request goes through, with stand-in sign-in and services.
// The order is part of the security: health check before sign-in, sign-in before files and API,
// same-site check before the JSON check, and no detail in a server error.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../../apps/api/src/app.js');
const { checkWrite } = require('../../apps/api/src/http/guards.js');

const ROOT = path.join(__dirname, '..', '..');
const ID = '00000000-0000-4000-8000-000000000001';
let base, server, calls, logged;
// Every service call receives the context { user, firmId } from sign-in; the fakes record it
const FIRM = 'f1a00000-0000-4000-8000-000000000001';
const households = {
  list: async ctx => { calls.push(['list', ctx.firmId]); return [{ id: ID }]; },
  create: async (ctx, state, opts) => { calls.push(['create', ctx.user, ctx.firmId, opts && opts.idempotencyKey]); return { id: ID, version: 1 }; },
  get: async (ctx, id) => ctx.firmId === FIRM && id === ID ? { id: ID, version: 1 } : null,
  audit: async (ctx, id) => ctx.firmId === FIRM && id === ID ? [{ field: 'created' }] : null,
  save: async (ctx, id, body) => id !== ID ? { notFound: true } : body.version !== 1 ? { conflict: { version: 1, updatedBy: 'x', updatedAt: 't' } } : body.boom ? (() => { throw new Error('secret detail'); })() : { version: 2, changes: 1 },
};
const authenticate = req => req.headers.authorization === 'ok' ? { user: 'sam', firmId: FIRM } : req.headers.authorization === 'locked' ? { locked: true } : null;
let storageUp = true;
const ready = async () => { if (!storageUp) throw new Error('database down: secret detail'); };

test.before(async () => {
  ({ server } = createApp({ config: { hsts: true, key: Buffer.alloc(32), root: ROOT }, households, authenticate, ready }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { calls = []; logged = []; });

const call = (method, p, { auth = 'ok', body, headers = {} } = {}) => fetch(base + p, { method, headers: { ...(auth ? { Authorization: auth } : {}), ...headers }, body });
const J = { 'Content-Type': 'application/json' };

test('1. the health check answers before sign-in', async () => {
  const r = await call('GET', '/healthz', { auth: 'locked' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
});

test('1b. /readyz answers before sign-in: 200 when storage answers, 503 with no detail when it does not', async () => {
  const r = await call('GET', '/readyz', { auth: '' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  storageUp = false;
  try {
    const d = await call('GET', '/readyz', { auth: 'locked' });
    assert.equal(d.status, 503); assert.deepEqual(await d.json(), { ok: false });
  } finally { storageUp = true; }
});

test('malformed requests are 400 "Bad request", never a server error: "//" and broken percent-encoding', async (t) => {
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  for (const p of ['//', '/%E0%A4%A', '/js/%zz']) {
    const r = await call('GET', p);
    assert.equal(r.status, 400, p); assert.deepEqual(await r.json(), { error: 'Bad request' }, p);
  }
  assert.deepEqual(logged, [], 'a bad request is not logged as a server error');
});

test('2. sign-in comes before files and the API: 401 with a challenge, 429 when locked', async () => {
  for (const p of ['/', '/core.js', '/api/me', '/api/households']) {
    const r = await call('GET', p, { auth: '' });
    assert.equal(r.status, 401, p); assert.match(r.headers.get('www-authenticate'), /^Basic realm="Household Wealth Profiler"/);
    const l = await call('GET', p, { auth: 'locked' });
    assert.equal(l.status, 429, p); assert.equal(l.headers.get('www-authenticate'), null);
    assert.deepEqual(await l.json(), { error: 'Too many failed sign-ins. Try again in 15 minutes.' });
  }
  assert.deepEqual(calls, [], 'no service was called');
});

test('3. outside /api/: files for GET, 405 for anything else (before the write checks)', async () => {
  assert.equal((await call('GET', '/core.js')).status, 200);
  const r = await call('POST', '/index.html', { headers: { Origin: 'https://evil.example' }, body: 'x' });
  assert.equal(r.status, 405); assert.deepEqual(await r.json(), { error: 'Method not allowed' });
});

test('4. writes: the same-site check comes before the JSON check', async () => {
  const evil = await call('POST', '/api/households', { headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(evil.status, 403);
  assert.equal((await call('POST', '/api/households', { headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.deepEqual(calls, [], 'refused writes never reach the service');
});

test('5. API routes, then 404 for everything else', async () => {
  assert.deepEqual(await (await call('GET', '/api/me')).json(), { user: 'sam', encrypted: true, production: false });
  assert.equal((await call('POST', '/api/households', { headers: J, body: '{"state":{}}' })).status, 201);
  assert.deepEqual(calls, [['create', 'sam', FIRM, undefined]], 'the signed-in user and firm are passed to the service');
  calls = [];
  assert.equal((await call('GET', '/api/households')).status, 200);
  assert.deepEqual(calls, [['list', FIRM]], 'reads carry the firm too');
  calls = [];
  assert.equal((await call('POST', '/api/households', { headers: { ...J, 'Idempotency-Key': 'abc-12345' }, body: '{"state":{}}' })).status, 201);
  assert.deepEqual(calls, [['create', 'sam', FIRM, 'abc-12345']], 'the Idempotency-Key header reaches the service');
  calls = [];
  const bad = await call('POST', '/api/households', { headers: { ...J, 'Idempotency-Key': 'short' }, body: '{"state":{}}' });
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: 'Idempotency-Key must be 8 to 200 letters, digits, "-" or "_"' });
  assert.deepEqual(calls, [], 'a bad key never reaches the service');
  for (const [m, p] of [['GET', '/api/nope'], ['GET', '/api/households/not-a-uuid'], ['GET', `/api/households/${ID.replace('1', '2')}`], ['DELETE', `/api/households/${ID}`]])
    assert.equal((await call(m, p, { headers: J, body: m === 'GET' ? undefined : '{}' })).status, 404, `${m} ${p}`);
});

test('save outcomes become 200, 404 and 409 replies', async () => {
  const put = (id, body) => call('PUT', `/api/households/${id}`, { headers: J, body: JSON.stringify(body) });
  assert.deepEqual(await (await put(ID, { version: 1 })).json(), { version: 2, changes: 1 });
  assert.equal((await put(ID.replace('1', '3'), { version: 1 })).status, 404);
  const c = await put(ID, { version: 7 });
  assert.equal(c.status, 409);
  assert.deepEqual(await c.json(), { error: 'This household was changed by someone else', version: 1, updatedBy: 'x', updatedAt: 't' });
});

// (413 "Request too large" is not checked here: the server cuts the upload off, so the reply races the reset)
test('errors: 400 keeps its message; anything unexpected is "Server error" with no detail', async (t) => {
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  const bad = await call('POST', '/api/households', { headers: J, body: '{oops' });
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: 'Invalid JSON' });
  const boom = await call('PUT', `/api/households/${ID}`, { headers: J, body: JSON.stringify({ version: 1, boom: true }) });
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { error: 'Server error' }, 'the detail stays on the server');
  assert.ok(logged.some(l => /secret detail/.test(l)), 'and is logged there');
});

test('every reply carries the security headers, with HSTS when switched on', async () => {
  for (const r of [await call('GET', '/healthz'), await call('GET', '/'), await call('GET', '/api/nope')]) {
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self';/, 'scripts come only from this server, never a CDN');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  }
});

test('checkWrite: GET passes; matching origin or x-forwarded-host passes; JSON required', () => {
  const req = (method, headers) => ({ method, headers: { host: 'app.example', ...headers } });
  assert.equal(checkWrite(req('GET', { origin: 'https://evil.example' })), null);
  assert.equal(checkWrite(req('PUT', { origin: 'https://app.example', 'content-type': 'application/json' })), null);
  assert.equal(checkWrite(req('PUT', { 'content-type': 'application/json; charset=utf-8' })), null, 'no Origin header (same-site tools)');
  assert.equal(checkWrite(req('PUT', { origin: 'https://proxy.example', 'x-forwarded-host': 'proxy.example', 'content-type': 'application/json' })), null);
  assert.deepEqual(checkWrite(req('PUT', { origin: 'https://evil.example', 'content-type': 'application/json' })), [403, { error: 'Cross-site request refused' }]);
  assert.deepEqual(checkWrite(req('POST', {})), [415, { error: 'Send JSON' }]);
  // "null" is what a browser sends from a sandboxed or opaque page; anything unparsable is not this site either
  for (const origin of ['null', 'not a url', ''])
    assert.deepEqual(checkWrite(req('PUT', { origin, 'content-type': 'application/json' })), origin === '' ? null : [403, { error: 'Cross-site request refused' }], JSON.stringify(origin));
});

test('a write with Origin "null" or an unparsable Origin is refused as cross-site (403), not a server error', async () => {
  for (const origin of ['null', 'not a url']) {
    const r = await call('POST', '/api/households', { headers: { ...J, Origin: origin }, body: '{"state":{}}' });
    assert.equal(r.status, 403, origin); assert.deepEqual(await r.json(), { error: 'Cross-site request refused' });
  }
  assert.deepEqual(calls, []);
});
