// API contract: the exact replies the front end relies on (status codes, keys, error texts,
// headers, static files). Shared by server.test.js (file storage) and postgres.test.js
// (PostgreSQL) so both storage modes are held to the same contract. Restructuring must keep
// every one of these passing unchanged.
//
// Call apiContract(ctx) inside a test file after its server has started. ctx() returns
// { base, sam, chris } where sam and chris are Basic-auth header objects for two users named
// 'sam' and 'chris'. Register it before any lockout test: a locked-out address fails everything.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('../../packages/core/core.js');

const J = { 'Content-Type': 'application/json' };
const keys = o => Object.keys(o).sort();
const json = v => JSON.parse(JSON.stringify(v)); // drops undefined, as the server's JSON does
// What the server stores for a submitted state (server.js: normalise, then drop audit)
const stored = st => { const s = H.normalise(json(st)); delete s.audit; return json(s); };
// The client-list summary server.js works out with core.js
function expectedSummary(state) {
  const s = H.normalise(state);
  const E = H.bind(s); const O = E.onboarding(E.compute()); const R = E.reviews(O);
  return json({ name: s.household.name, reference: s.household.reference, stage: O.stage, rating: O.rating,
    nextReview: O.nextReview, blockers: O.blockerCount, due: R.nextDue, overdue: R.overdue });
}

const LIST_KEYS = ['blockers', 'due', 'id', 'name', 'nextReview', 'overdue', 'rating', 'reference', 'stage', 'updatedAt', 'updatedBy', 'version'];
const RECORD_KEYS = ['createdAt', 'createdBy', 'id', 'state', 'updatedAt', 'updatedBy', 'version'];
const CONFLICT_KEYS = ['error', 'updatedAt', 'updatedBy', 'version'];
const CREATED_AUDIT_KEYS = ['field', 'from', 'to', 'ts', 'user'];
const CHANGE_AUDIT_KEYS = ['field', 'from', 'to', 'ts', 'user', 'version'];

function apiContract(ctx) {
  test.describe('API contract', () => {
    let base, sam, chris, id, sent;
    const call = (method, p, { who, body, headers = {} } = {}) =>
      fetch(base + p, { method, headers: { ...(who || {}), ...(body !== undefined ? J : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    test.before(() => { ({ base, sam, chris } = ctx()); });

    test('health check: 200 {ok:true} without signing in', async () => {
      const r = await call('GET', '/healthz');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
      assert.match(r.headers.get('content-type'), /^application\/json/);
    });

    test('every reply carries the security headers', async () => {
      for (const r of [await call('GET', '/healthz'), await call('GET', '/api/me', { who: sam }), await call('GET', '/', { who: sam })]) {
        assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
        assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(r.headers.get('x-frame-options'), 'DENY');
        assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
        assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
      }
      assert.equal((await call('GET', '/api/me', { who: sam })).headers.get('cache-control'), 'no-store');
    });

    test('not signed in: 401 with a Basic challenge', async () => {
      for (const p of ['/', '/api/me', '/api/households']) {
        const r = await call('GET', p);
        assert.equal(r.status, 401, p);
        assert.deepEqual(await r.json(), { error: 'Sign in required' });
        assert.equal(r.headers.get('www-authenticate'), 'Basic realm="Household Wealth Profiler", charset="UTF-8"');
      }
    });

    test('GET /api/me: exactly {user, encrypted}', async () => {
      const r = await call('GET', '/api/me', { who: sam });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.deepEqual(keys(j), ['encrypted', 'user']);
      assert.equal(j.user, 'sam'); assert.equal(typeof j.encrypted, 'boolean');
    });

    test('POST /api/households: 201 {id, version: 1}', async () => {
      sent = H.sample(); sent.household.name = 'Contract household';
      const r = await call('POST', '/api/households', { who: sam, body: { state: sent } });
      assert.equal(r.status, 201);
      const j = await r.json();
      assert.deepEqual(keys(j), ['id', 'version']);
      assert.match(j.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(j.version, 1);
      id = j.id;
    });

    test('GET /api/households/:id: the record with the normalised state', async () => {
      const r = await call('GET', '/api/households/' + id, { who: sam });
      assert.equal(r.status, 200);
      const rec = await r.json();
      assert.deepEqual(keys(rec), RECORD_KEYS);
      assert.equal(rec.id, id); assert.equal(rec.version, 1);
      assert.equal(rec.createdBy, 'sam'); assert.equal(rec.updatedBy, 'sam');
      assert.equal(rec.createdAt, rec.updatedAt); assert.ok(!isNaN(Date.parse(rec.createdAt)));
      assert.deepEqual(rec.state, stored(sent));
    });

    test('GET /api/households: list rows carry the summary core.js works out', async () => {
      const r = await call('GET', '/api/households', { who: sam });
      assert.equal(r.status, 200);
      const list = await r.json();
      assert.ok(Array.isArray(list));
      for (const row of list) assert.deepEqual(keys(row), LIST_KEYS);
      const mine = list.find(x => x.id === id);
      assert.ok(mine, 'new household is listed');
      const { id: _i, version, updatedAt, updatedBy, ...summary } = mine;
      assert.deepEqual(summary, expectedSummary(stored(sent)));
      assert.equal(version, 1); assert.equal(updatedBy, 'sam'); assert.ok(updatedAt);
      const times = list.map(x => x.updatedAt);
      assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
    });

    test('PUT with nothing changed: 200 {version, changes: 0}, no new version', async () => {
      const r = await call('PUT', '/api/households/' + id, { who: sam, body: { version: 1, state: sent } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { version: 1, changes: 0 });
    });

    let edited;
    test('PUT with changes: 200 {version: +1, changes: number of changed fields}', async () => {
      edited = json(sent); edited.household.reference = 'HH-CONTRACT'; edited.members[1].poaType = 'bank';
      const expected = H.diff(stored(sent), stored(edited)).length;
      assert.equal(expected, 2);
      const r = await call('PUT', '/api/households/' + id, { who: chris, body: { version: 1, state: edited } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { version: 2, changes: expected });
      const rec = await (await call('GET', '/api/households/' + id, { who: sam })).json();
      assert.equal(rec.version, 2); assert.equal(rec.updatedBy, 'chris'); assert.equal(rec.createdBy, 'sam');
      assert.deepEqual(rec.state, stored(edited));
    });

    test('PUT on an old version: 409 with who saved last', async () => {
      const r = await call('PUT', '/api/households/' + id, { who: sam, body: { version: 1, state: sent } });
      assert.equal(r.status, 409);
      const j = await r.json();
      assert.deepEqual(keys(j), CONFLICT_KEYS);
      assert.equal(j.error, 'This household was changed by someone else');
      assert.equal(j.version, 2); assert.equal(j.updatedBy, 'chris');
    });

    test('GET /api/households/:id/audit: newest first, field-level entries', async () => {
      const r = await call('GET', `/api/households/${id}/audit`, { who: sam });
      assert.equal(r.status, 200);
      const audit = await r.json();
      assert.equal(audit.length, 3);
      const created = audit[audit.length - 1];
      assert.deepEqual(keys(created), CREATED_AUDIT_KEYS);
      assert.deepEqual({ field: created.field, from: created.from, to: created.to, user: created.user },
        { field: 'created', from: '', to: 'Contract household', user: 'sam' });
      const changes = audit.slice(0, 2);
      for (const c of changes) { assert.deepEqual(keys(c), CHANGE_AUDIT_KEYS); assert.equal(c.user, 'chris'); assert.equal(c.version, 2); }
      assert.deepEqual(changes.map(c => c.field).sort(), ['household.reference', 'members[1].poaType']);
      const ref = changes.find(c => c.field === 'household.reference');
      assert.equal(ref.from, 'HH-0001'); assert.equal(ref.to, 'HH-CONTRACT');
    });

    test('unknown households and routes: 404 {error: "Not found"}', async () => {
      const unknown = crypto.randomUUID();
      for (const [m, p] of [['GET', '/api/households/' + unknown], ['GET', `/api/households/${unknown}/audit`], ['GET', '/api/households/not-an-id'],
        ['GET', '/api/nope'], ['DELETE', '/api/households/' + id], ['PATCH', '/api/households/' + id], ['GET', '/no-such-file.js']]) {
        const r = await call(m, p, { who: sam, ...(m === 'GET' ? {} : { body: {} }) });
        assert.equal(r.status, 404, `${m} ${p}`);
        assert.deepEqual(await r.json(), { error: 'Not found' });
      }
      const put = await call('PUT', '/api/households/' + unknown, { who: sam, body: { version: 1, state: sent } });
      assert.equal(put.status, 404); assert.deepEqual(await put.json(), { error: 'Not found' });
    });

    test('bad requests: 405, 415, 403 and 400 with their messages', async () => {
      let r = await call('POST', '/index.html', { who: sam, body: {} });
      assert.equal(r.status, 405); assert.deepEqual(await r.json(), { error: 'Method not allowed' });
      r = await call('POST', '/api/households', { who: sam, body: '{}', headers: { 'Content-Type': 'text/plain' } });
      assert.equal(r.status, 415); assert.deepEqual(await r.json(), { error: 'Send JSON' });
      r = await call('POST', '/api/households', { who: sam, body: { state: sent }, headers: { Origin: 'https://evil.example' } });
      assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'Cross-site request refused' });
      r = await call('POST', '/api/households', { who: sam, body: '{not json' });
      assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Invalid JSON' });
    });

    test('the app files are served with their types', async () => {
      const files = { '/': /^text\/html/, '/index.html': /^text\/html/, '/app.js': /^text\/javascript/, '/core.js': /^text\/javascript/,
        '/cloud.js': /^text\/javascript/, '/config.js': /^text\/javascript/, '/styles.css': /^text\/css/ };
      for (const [p, type] of Object.entries(files)) {
        const r = await call('GET', p, { who: sam });
        assert.equal(r.status, 200, p);
        assert.match(r.headers.get('content-type'), type, p);
        assert.equal(r.headers.get('cache-control'), 'no-cache', p);
        assert.ok((await r.text()).length > 0, p);
      }
      assert.match(await (await call('GET', '/', { who: sam })).text(), /<script src="core\.js"><\/script>/);
    });
  });
}

module.exports = { apiContract };
