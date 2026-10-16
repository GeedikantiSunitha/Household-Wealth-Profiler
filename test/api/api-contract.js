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
    nextReview: O.nextReview, blockers: O.blockerCount, due: R.nextDue, overdue: R.overdue, tasks: H.openTasks(s) });
}

const LIST_KEYS = ['blockers', 'due', 'id', 'name', 'nextReview', 'overdue', 'rating', 'reference', 'stage', 'tasks', 'updatedAt', 'updatedBy', 'version'];
const FIRM_KEYS = ['settings', 'updatedAt', 'updatedBy', 'version'];
const RECORD_KEYS = ['createdAt', 'createdBy', 'id', 'state', 'updatedAt', 'updatedBy', 'version'];
const CONFLICT_KEYS = ['code', 'error', 'updatedAt', 'updatedBy', 'version'];
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

    test('readiness: /readyz is 200 {ok:true} without signing in when storage answers', async () => {
      const r = await call('GET', '/readyz');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    });

    test('every reply carries the security headers', async () => {
      for (const r of [await call('GET', '/healthz'), await call('GET', '/api/me', { who: sam }), await call('GET', '/', { who: sam })]) {
        assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
        assert.match(r.headers.get('content-security-policy'), /script-src 'self';/, 'no script from any other site');
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
        assert.deepEqual(await r.json(), { error: 'Sign in required', code: 'sign_in_required' });
        assert.equal(r.headers.get('www-authenticate'), 'Basic realm="Household Wealth Profiler", charset="UTF-8"');
      }
    });

    test('GET /api/me: exactly {user, encrypted, production}', async () => {
      const r = await call('GET', '/api/me', { who: sam });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.deepEqual(keys(j), ['encrypted', 'production', 'user']);
      assert.equal(j.user, 'sam'); assert.equal(typeof j.encrypted, 'boolean'); assert.equal(j.production, false);
    });

    // The contract household has its own client reference: a reference may exist once per firm
    const REF = 'HH-C-' + crypto.randomUUID().slice(0, 6).toUpperCase();
    test('POST /api/households: 201 {id, version: 1}', async () => {
      sent = H.sample(); sent.household.name = 'Contract household'; sent.household.reference = REF;
      const r = await call('POST', '/api/households', { who: sam, body: { state: sent } });
      assert.equal(r.status, 201);
      const j = await r.json();
      assert.deepEqual(keys(j), ['id', 'version']);
      assert.match(j.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(j.version, 1);
      id = j.id;
    });

    test('a client reference another household in the firm already has: 409 on create and on save, in any spelling', async () => {
      const again = H.blank(); again.household.reference = ' ' + REF.toLowerCase() + ' ';
      const r = await call('POST', '/api/households', { who: chris, body: { state: again } });
      assert.equal(r.status, 409);
      const dup = await r.json(); assert.deepEqual(dup, { error: 'Another household in this firm already has this client reference', code: 'duplicate_reference' });
      assert.ok(!JSON.stringify(dup).includes(REF), 'the reference itself is not echoed');
      const other = H.blank(); other.household.reference = REF + '-B';
      const { id: oid } = await (await call('POST', '/api/households', { who: chris, body: { state: other } })).json();
      other.household.reference = REF.toLowerCase();
      const s = await call('PUT', '/api/households/' + oid, { who: chris, body: { version: 1, state: other } });
      assert.equal(s.status, 409);
      assert.deepEqual(await s.json(), { error: 'Another household in this firm already has this client reference', code: 'duplicate_reference' });
      assert.equal((await (await call('GET', '/api/households/' + oid, { who: chris })).json()).version, 1, 'nothing saved');
    });

    test('POST with the same Idempotency-Key twice: the same reply, one household; a bad key is 400', async () => {
      const key = 'contract-' + crypto.randomUUID();
      const st = H.blank(); st.household.name = 'Once only ' + key.slice(-6); st.household.reference = 'ONCE-' + key.slice(-6); // a reference: the repeat must not be refused as a duplicate of itself
      const before = (await (await call('GET', '/api/households', { who: sam })).json()).length;
      const a = await call('POST', '/api/households', { who: sam, body: { state: st }, headers: { 'Idempotency-Key': key } });
      const b = await call('POST', '/api/households', { who: sam, body: { state: st }, headers: { 'Idempotency-Key': key } });
      assert.equal(a.status, 201); assert.equal(b.status, 201);
      const ja = await a.json(); assert.deepEqual(await b.json(), ja);
      const after = (await (await call('GET', '/api/households', { who: sam })).json()).length;
      assert.equal(after, before + 1);
      // The same key with a different request is refused, not answered with the first reply; the original repeat still replays
      const other = H.blank(); other.household.name = 'Something else ' + key.slice(-6);
      const c = await call('POST', '/api/households', { who: sam, body: { state: other }, headers: { 'Idempotency-Key': key } });
      assert.equal(c.status, 422); assert.deepEqual(await c.json(), { error: 'This Idempotency-Key was already used for a different request', code: 'idempotency_mismatch' });
      assert.deepEqual(await (await call('POST', '/api/households', { who: sam, body: { state: st }, headers: { 'Idempotency-Key': key } })).json(), ja, 'the original request still replays');
      assert.equal((await (await call('GET', '/api/households', { who: sam })).json()).length, before + 1, 'still one household');
      const bad = await call('POST', '/api/households', { who: sam, body: { state: st }, headers: { 'Idempotency-Key': 'no spaces allowed' } });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: 'Idempotency-Key must be 8 to 200 letters, digits, "-" or "_"', code: 'bad_idempotency_key' });
    });

    test('a value outside the field rules: 400 invalid_field with every field path and rule, never the value; nothing stored (create, save, firm)', async () => {
      const st = H.blank(); st.household.name = 'Rules ' + crypto.randomUUID().slice(0, 8); st.household.region = 'SECRET-REGION';
      st.members = [H.defaults('members')]; st.members[0].dob = 'SECRET-DATE'; st.accounts = [H.defaults('accounts')]; st.accounts[0].value = 'SECRET-VALUE';
      const before = (await (await call('GET', '/api/households', { who: sam })).json()).length;
      const r = await call('POST', '/api/households', { who: sam, body: { state: st } });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.deepEqual(j, { error: 'Invalid household: household.region must be one of the listed options', code: 'invalid_field', errors: [
        { field: 'household.region', message: 'must be one of the listed options' },
        { field: 'members[0].dob', message: 'must be a date (YYYY-MM-DD)' },
        { field: 'accounts[0].value', message: 'must be a number' }] });
      assert.ok(!/SECRET/.test(JSON.stringify(j)), 'no submitted value in the reply');
      assert.equal((await (await call('GET', '/api/households', { who: sam })).json()).length, before, 'nothing created');
      // save: the stored version is unchanged
      const ok = H.blank(); ok.household.name = st.household.name; ok.household.reference = 'RULES-' + crypto.randomUUID().slice(0, 8);
      const { id: hid } = await (await call('POST', '/api/households', { who: sam, body: { state: ok } })).json();
      const bad = json(ok); bad.household.valuationDate = '2026-02-30';
      const s = await call('PUT', '/api/households/' + hid, { who: sam, body: { version: 1, state: bad } });
      assert.equal(s.status, 400);
      assert.deepEqual(await s.json(), { error: 'Invalid household: household.valuationDate must be a date (YYYY-MM-DD)', code: 'invalid_field', errors: [{ field: 'household.valuationDate', message: 'must be a date (YYYY-MM-DD)' }] });
      assert.equal((await (await call('GET', '/api/households/' + hid, { who: sam })).json()).version, 1, 'nothing saved');
      // a numeric string is stored as a number
      const num = json(ok); num.accounts = [H.defaults('accounts')]; num.accounts[0].value = '12,500';
      assert.equal((await call('PUT', '/api/households/' + hid, { who: sam, body: { version: 1, state: num } })).status, 200);
      assert.equal((await (await call('GET', '/api/households/' + hid, { who: sam })).json()).state.accounts[0].value, 12500);
      // firm settings
      const f0 = await (await call('GET', '/api/firm', { who: sam })).json();
      const settings = json(f0.settings); settings.team = [{ ...H.defaults('team'), name: 'Alex', role: 'SECRET-ROLE' }];
      const fr = await call('PUT', '/api/firm', { who: sam, body: { version: f0.version, settings } });
      assert.equal(fr.status, 400);
      const fj = await fr.json();
      assert.deepEqual(fj, { error: 'Invalid firm settings: team[0].role must be one of the listed options', code: 'invalid_field', errors: [{ field: 'team[0].role', message: 'must be one of the listed options' }] });
      assert.ok(!/SECRET/.test(JSON.stringify(fj)));
      assert.equal((await (await call('GET', '/api/firm', { who: sam })).json()).version, f0.version, 'nothing saved');
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
      assert.equal(j.error, 'This household was changed by someone else'); assert.equal(j.code, 'version_conflict');
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
      assert.equal(ref.from, REF); assert.equal(ref.to, 'HH-CONTRACT');
    });

    // Firm settings: works from whatever version is there, so other tests may have saved before
    test('firm settings: GET, PUT with a version check, 409, no-change save, audit trail', async () => {
      const f0 = await (await call('GET', '/api/firm', { who: sam })).json();
      assert.deepEqual(keys(f0), FIRM_KEYS);
      assert.deepEqual(f0.settings, json(H.firmNormalise(f0.settings)), 'stored settings are normalised');
      const v = f0.version;
      const settings = json(f0.settings); const name = 'Contract Firm ' + crypto.randomUUID().slice(0, 8); settings.firm.name = name;
      const expected = H.firmDiff(f0.settings, H.firmNormalise(settings)).length;
      assert.equal(expected, 1);
      let r = await call('PUT', '/api/firm', { who: sam, body: { version: v, settings } });
      assert.equal(r.status, 200); assert.deepEqual(await r.json(), { version: v + 1, changes: 1 });
      r = await call('PUT', '/api/firm', { who: chris, body: { version: v + 1, settings } });
      assert.equal(r.status, 200); assert.deepEqual(await r.json(), { version: v + 1, changes: 0 });
      r = await call('PUT', '/api/firm', { who: chris, body: { version: v, settings } });
      assert.equal(r.status, 409);
      const j = await r.json();
      assert.deepEqual(keys(j), CONFLICT_KEYS);
      assert.equal(j.error, 'Firm settings were changed by someone else'); assert.equal(j.code, 'version_conflict');
      assert.equal(j.version, v + 1); assert.equal(j.updatedBy, 'sam'); assert.ok(j.updatedAt);
      const f1 = await (await call('GET', '/api/firm', { who: chris })).json();
      assert.equal(f1.version, v + 1); assert.equal(f1.updatedBy, 'sam'); assert.equal(f1.settings.firm.name, name);
      const audit = await (await call('GET', '/api/firm/audit', { who: chris })).json();
      assert.deepEqual(keys(audit[0]), CHANGE_AUDIT_KEYS);
      assert.deepEqual({ field: audit[0].field, to: audit[0].to, user: audit[0].user, version: audit[0].version }, { field: 'firm.name', to: name, user: 'sam', version: v + 1 });
      const list = await (await call('GET', '/api/households', { who: sam })).json();
      assert.ok(list.every(h => h.id !== 'firm'), 'firm settings never show in the client list');
    });

    test('GET /api/prices without a provider key: 501, and the message points to CSV import', async () => {
      const r = await call('GET', '/api/prices?symbol=VWRL.LON', { who: sam });
      assert.equal(r.status, 501);
      assert.deepEqual(await r.json(), { error: 'Automatic prices are not set up. Ask your administrator to add an Alpha Vantage key, or import a CSV.', code: 'not_configured' });
    });

    test('unknown households and routes: 404 {error: "Not found"}', async () => {
      const unknown = crypto.randomUUID();
      for (const [m, p] of [['GET', '/api/households/' + unknown], ['GET', `/api/households/${unknown}/audit`], ['GET', '/api/households/not-an-id'],
        ['GET', '/api/nope'], ['DELETE', '/api/households/' + id], ['PATCH', '/api/households/' + id], ['GET', '/no-such-file.js']]) {
        const r = await call(m, p, { who: sam, ...(m === 'GET' ? {} : { body: {} }) });
        assert.equal(r.status, 404, `${m} ${p}`);
        assert.deepEqual(await r.json(), { error: 'Not found', code: 'not_found' });
      }
      const put = await call('PUT', '/api/households/' + unknown, { who: sam, body: { version: 1, state: sent } });
      assert.equal(put.status, 404); assert.deepEqual(await put.json(), { error: 'Not found', code: 'not_found' });
    });

    test('bad requests: 405, 415, 403 and 400 with their messages', async () => {
      let r = await call('POST', '/index.html', { who: sam, body: {} });
      assert.equal(r.status, 405); assert.deepEqual(await r.json(), { error: 'Method not allowed', code: 'method_not_allowed' });
      r = await call('POST', '/api/households', { who: sam, body: '{}', headers: { 'Content-Type': 'text/plain' } });
      assert.equal(r.status, 415); assert.deepEqual(await r.json(), { error: 'Send JSON', code: 'json_required' });
      r = await call('POST', '/api/households', { who: sam, body: { state: sent }, headers: { Origin: 'https://evil.example' } });
      assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'Cross-site request refused', code: 'cross_site' });
      r = await call('POST', '/api/households', { who: sam, body: '{not json' });
      assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Invalid JSON', code: 'invalid_json' });
      r = await call('POST', '/api/households', { who: sam, body: { state: sent }, headers: { Origin: 'null' } });
      assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'Cross-site request refused', code: 'cross_site' });
      for (const p of ['//', '/%E0%A4%A']) {
        r = await call('GET', p, { who: sam });
        assert.equal(r.status, 400, p); assert.deepEqual(await r.json(), { error: 'Bad request', code: 'bad_request' });
      }
    });

    test('the app files are served with their types', async () => {
      const files = { '/': /^text\/html/, '/index.html': /^text\/html/, '/js/main.js': /^text\/javascript/, '/core.js': /^text\/javascript/,
        '/styles.css': /^text\/css/, '/vendor/xlsx.full.min.js': /^text\/javascript/ };
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
