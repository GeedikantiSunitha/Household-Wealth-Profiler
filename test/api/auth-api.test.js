// The sign-in API (apps/api/src/routes/auth.js) on PostgreSQL: sign in with email and password,
// what the replies give away (nothing about which accounts exist), the progressive delay and the
// per-address limiter, sign-out, firm switching, and the auth events behind each. The second step
// (authenticator) is covered by totp-api.test.js. Runs when TEST_DATABASE_URL points at a scratch
// database, in a schema of its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createApp } = require('../../apps/api/src/app.js');
const { createAuth } = require('../../apps/api/src/auth');
const { createAuthStore } = require('../../apps/api/src/auth/store.js');
const { createSessions } = require('../../apps/api/src/auth/sessions.js');
const { createAuthRoutes } = require('../../apps/api/src/routes/auth.js');
const { createLimiter, AUTH_LIMIT } = require('../../apps/api/src/auth/limiter.js');
const { hashPassword } = require('../../apps/api/src/auth/password.js');
const { createPool } = require('../../apps/api/src/db/pool.js');
const { migrate, pgClient } = require('../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../apps/api/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const FIRM_B = '0f1e0000-0000-4000-8000-00000000000b';
const PASS = 'correct horse battery staple';

test.describe('sign-in API', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_signin_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  let admin, pool, store, sessions, server, base, sam, notified;
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const now = () => clock.t;

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    const hash = await hashPassword(PASS);
    await asRole('hwp_owner', async c => {
      await c.query(`insert into firms (id, name) values ($1, 'Firm B')`, [FIRM_B]);
      sam = (await c.query(`insert into users (email, name, password_hash, password_set_at) values ('sam@example.com', 'Sam Adviser', $1, now()) returning id`, [hash])).rows[0].id;
      await c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser'), ($1, $3, 'admin')`, [sam, DEFAULT_FIRM_ID, FIRM_B]);
      await c.query(`insert into users (email, name, password_hash, active) values ('gone@example.com', 'Gone', $1, false)`, [hash]);
      await c.query(`insert into users (email, name) values ('nopass@example.com', 'No Password')`);
      const lonely = (await c.query(`insert into users (email, name, password_hash) values ('nofirm@example.com', 'No Firm', $1) returning id`, [hash])).rows[0].id;
      await c.query(`insert into memberships (user_id, firm_id, role, active) values ($1, $2, 'adviser', false)`, [lonely, DEFAULT_FIRM_ID]);
    });
    pool = createPool(urlFor('hwp_app'), 2);
    store = createAuthStore({ pool, now: () => new Date(clock.t) });
    sessions = createSessions({ store, secret: crypto.randomBytes(32), secure: false, now });
    notified = [];
    const notify = { lockoutWarning: async (user, info) => { notified.push(['lockout', user.email, info.failures]); } };
    const limiter = createLimiter({ ...AUTH_LIMIT, now });
    const { authenticate } = createAuth({ users: new Map(), clientIpHeader: 'x-client-ip' }, { authStore: store, sessions });
    const authRoutes = createAuthRoutes({ authStore: store, sessions, limiter, notify, clientIpHeader: 'x-client-ip', now });
    const households = { list: async () => [], create: async () => ({ id: '0', version: 1 }), get: async () => null, audit: async () => null, save: async () => ({ notFound: true }) };
    const firm = { get: async () => ({ version: 0, settings: {}, updatedAt: '', updatedBy: '' }), audit: async () => [], save: async () => ({ version: 1, changes: 1 }) };
    ({ server } = createApp({ config: { hsts: false, key: Buffer.alloc(32), root: ROOT, users: new Map() }, households, firm, prices: { enabled: false }, authenticate, authRoutes, ready: async () => {} }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 120000 });
  test.after(async () => { if (server) server.close(); if (pool) await pool.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });
  test.beforeEach(() => { clock.t += 16 * 60e3; }); // a fresh limiter window for every test

  const J = { 'Content-Type': 'application/json' };
  const post = (p, body, { cookie, csrf, ip = '10.0.0.1' } = {}) => fetch(base + p, { method: 'POST', headers: { ...J, 'X-Client-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) });
  const get = (p, { cookie, ip = '10.0.0.1' } = {}) => fetch(base + p, { headers: { 'X-Client-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
  const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
  const events = async email => (await asRole('hwp_owner', c => c.query('select event, outcome, detail from auth_events where email = $1 order by id', [email]))).rows.map(e => e.event + ':' + e.outcome);

  test('a wrong password, an unknown email, a deactivated account, one without a password and one without a firm all get the same 401; events tell them apart', async () => {
    const t0 = process.hrtime.bigint();
    const unknown = await post('/api/auth/sign-in', { email: 'nobody@example.com', password: PASS });
    const unknownMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const bodies = [];
    for (const [email, password] of [['sam@example.com', 'wrong password here'], ['nobody@example.com', PASS], ['gone@example.com', PASS], ['nopass@example.com', PASS], ['nofirm@example.com', PASS]]) {
      const r = email === 'nobody@example.com' ? unknown : await post('/api/auth/sign-in', { email, password });
      assert.equal(r.status, 401, email); assert.equal(r.headers.get('set-cookie'), null, email); assert.equal(r.headers.get('www-authenticate'), null, 'no Basic challenge');
      bodies.push(JSON.stringify(await r.json()));
    }
    assert.equal(new Set(bodies).size, 1, 'the same reply for every failure: ' + bodies.join(' | '));
    assert.equal(bodies[0], JSON.stringify({ error: 'Email or password is not right', code: 'bad_credentials' }));
    assert.deepEqual(await events('sam@example.com'), ['sign_in:bad_password']);
    assert.deepEqual(await events('nobody@example.com'), ['sign_in:unknown']);
    assert.deepEqual(await events('gone@example.com'), ['sign_in:inactive']);
    assert.deepEqual(await events('nopass@example.com'), ['sign_in:no_password']);
    assert.deepEqual(await events('nofirm@example.com'), ['sign_in:no_firm']);
    console.log(`a sign-in attempt for an unknown email took ${unknownMs.toFixed(0)} ms (a real scrypt at the same parameters)`);
  });

  test('the right password opens a password-stage session: a cookie, the CSRF token and the next step; data stays out of reach until the second step', async () => {
    const t0 = process.hrtime.bigint();
    const r = await post('/api/auth/sign-in', { email: '  SAM@Example.com ', password: PASS });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(Object.keys(j).sort(), ['csrf', 'next', 'stage']); assert.equal(j.next, 'enrol', 'no authenticator yet: enrolment comes first'); assert.equal(j.stage, 'password');
    assert.match(r.headers.get('set-cookie'), /^hwp_session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
    const cookie = cookieOf(r);
    const me = await get('/api/me', { cookie });
    assert.equal(me.status, 401); assert.equal((await me.json()).code, 'second_step_required');
    assert.deepEqual((await events('sam@example.com')).slice(-1), ['sign_in:ok']);
    assert.equal((await asRole('hwp_owner', c => c.query('select failed_attempts from users where id = $1', [sam]))).rows[0].failed_attempts, 0, 'the earlier failure is cleared');
    console.log(`one sign-in (email and password, scrypt at the OWASP parameters, session issued) took ${ms.toFixed(0)} ms`);
    // a sign-in while already holding a session ends the old one
    const t1 = process.hrtime.bigint();
    const again = await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS }, { cookie });
    console.log(`a second, warm sign-in took ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(0)} ms`);
    assert.equal(again.status, 200);
    const old = await post('/api/auth/sign-out', {}, { cookie, csrf: j.csrf });
    assert.equal(old.status, 401, 'the earlier session has ended');
  });

  test('missing or malformed fields are a 400 that names the problem, never a server error', async () => {
    for (const body of [{}, { email: 'sam@example.com' }, { password: PASS }, { email: 7, password: PASS }, { email: 'sam@example.com', password: 'x'.repeat(5000) }]) {
      const r = await post('/api/auth/sign-in', body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.deepEqual(await r.json(), { error: 'Email and password are required', code: 'bad_request' });
    }
  });

  test('progressive delay: from the third failure the account is not tried again until the delay has passed, even with the right password; the fifth failure raises a warning', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: 'wrong ' + i })).status, 401);
    let r = await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS });
    assert.equal(r.status, 401, 'within the 1-second delay after the third failure'); assert.equal((await r.json()).code, 'bad_credentials', 'the same reply: the delay does not reveal the account exists');
    assert.deepEqual((await events('sam@example.com')).slice(-1), ['sign_in:slowed']);
    clock.t += 1001;
    r = await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS });
    assert.equal(r.status, 200, 'after the delay the right password signs in');
    await post('/api/auth/sign-out', {}, { cookie: cookieOf(r), csrf: (await r.json()).csrf });
    assert.deepEqual(notified, [], 'no warning yet');
    for (let i = 0; i < 5; i++) { clock.t += 70e3; assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: 'wrong again ' + i })).status, 401); }
    assert.deepEqual(notified, [['lockout', 'sam@example.com', 5]], 'the account holder is warned once at the fifth consecutive failure');
    assert.ok((await events('sam@example.com')).includes('lockout_notice:sent'));
    clock.t += 61e3;
    r = await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS });
    assert.equal(r.status, 200);
    await post('/api/auth/sign-out', {}, { cookie: cookieOf(r), csrf: (await r.json()).csrf });
  });

  test('per-address limiter: too many attempts from one address are refused for a while; another address is not affected', async () => {
    assert.deepEqual(AUTH_LIMIT, { max: 20, windowMs: 15 * 60e3 });
    let last;
    for (let i = 0; i < 20; i++) last = await post('/api/auth/sign-in', { email: 'nobody@example.com', password: 'x'.repeat(12) }, { ip: '203.0.113.9' });
    assert.equal(last.status, 401);
    const r = await post('/api/auth/sign-in', { email: 'nobody@example.com', password: 'x'.repeat(12) }, { ip: '203.0.113.9' });
    assert.equal(r.status, 429); assert.deepEqual(await r.json(), { error: 'Too many attempts from this address. Try again in 15 minutes.', code: 'too_many_attempts' });
    assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS }, { ip: '203.0.113.9' })).status, 429, 'even with the right password');
    assert.equal((await post('/api/auth/sign-in', { email: 'nobody@example.com', password: 'x'.repeat(12) }, { ip: '198.51.100.7' })).status, 401, 'another address');
    clock.t += 15 * 60e3 + 1;
    assert.equal((await post('/api/auth/sign-in', { email: 'nobody@example.com', password: 'x'.repeat(12) }, { ip: '203.0.113.9' })).status, 401, 'the window has passed');
  });

  test('sign-out ends the session and clears the cookie, at any stage; without a session it is 401', async () => {
    const r = await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS });
    const cookie = cookieOf(r), { csrf } = await r.json();
    assert.equal((await post('/api/auth/sign-out', {}, { cookie })).status, 403, "sign-out is a write: it needs the session's token");
    const out = await post('/api/auth/sign-out', {}, { cookie, csrf });
    assert.equal(out.status, 200); assert.deepEqual(await out.json(), { ok: true });
    assert.match(out.headers.get('set-cookie'), /^hwp_session=; Max-Age=0; /);
    assert.equal((await post('/api/auth/sign-out', {}, { cookie, csrf })).status, 401);
    assert.equal((await post('/api/auth/sign-out', {})).status, 401);
    assert.deepEqual((await events('sam@example.com')).slice(-2), ['sign_in:ok', 'sign_out:ok']);
  });

  test('with the second step done: the firms the user belongs to, switching firm rotates the session, sign out everywhere ends every session', async () => {
    const a = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    const b = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    const cookieA = a.cookie.split(';')[0], cookieB = b.cookie.split(';')[0];
    const firms = await get('/api/auth/firms', { cookie: cookieA });
    assert.equal(firms.status, 200);
    assert.deepEqual(await firms.json(), [{ firmId: DEFAULT_FIRM_ID, firmName: 'Default firm', role: 'adviser' }, { firmId: FIRM_B, firmName: 'Firm B', role: 'admin' }]);
    let r = await post('/api/auth/firm', { firmId: FIRM_B }, { cookie: cookieA });
    assert.equal(r.status, 403, 'a write needs the CSRF token'); assert.equal((await r.json()).code, 'csrf');
    r = await post('/api/auth/firm', { firmId: '0f1e0000-0000-4000-8000-00000000000c' }, { cookie: cookieA, csrf: a.csrf });
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'You are not a member of that firm', code: 'forbidden' });
    r = await post('/api/auth/firm', { firmId: FIRM_B }, { cookie: cookieA, csrf: a.csrf });
    assert.equal(r.status, 200);
    const sw = await r.json(); assert.equal(sw.firmId, FIRM_B); assert.equal(sw.firmName, 'Firm B'); assert.equal(sw.role, 'admin'); assert.notEqual(sw.csrf, a.csrf);
    const newCookie = cookieOf(r); assert.notEqual(newCookie, cookieA, 'a new session id');
    assert.equal((await get('/api/me', { cookie: cookieA })).status, 401, 'the old id has ended');
    const me = await (await get('/api/me', { cookie: newCookie })).json();
    assert.equal(me.firmId, FIRM_B); assert.equal(me.role, 'admin'); assert.equal(me.csrf, sw.csrf);
    assert.ok((await events('sam@example.com')).includes('firm_switch:ok'));
    r = await post('/api/auth/sign-out-all', {}, { cookie: newCookie, csrf: sw.csrf });
    assert.equal(r.status, 200); const all = await r.json(); assert.equal(all.ok, true); assert.ok(all.ended >= 2, 'both sessions of this test ended (and any left open by earlier tests): ' + all.ended);
    assert.equal((await get('/api/me', { cookie: newCookie })).status, 401); assert.equal((await get('/api/me', { cookie: cookieB })).status, 401, 'the other session too');
    assert.ok((await events('sam@example.com')).includes('sign_out_all:ok'));
  });

  test('an unknown sign-in route is 404; a GET to a write route is 405-free 404 (no file is served under /api/)', async () => {
    assert.equal((await post('/api/auth/nope', {})).status, 404);
    assert.equal((await get('/api/auth/sign-in')).status, 404);
  });
});
