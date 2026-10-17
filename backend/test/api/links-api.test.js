// Links and requests (2.6) on PostgreSQL: forgot password and the reset link, the invitation link
// for a new account, the sign-in state for a half-finished session, registration, and the
// emails behind them (captured here, never sent). Runs when TEST_DATABASE_URL points at a scratch
// database, in a schema of its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createApp } = require('../../../backend/src/app.js');
const { createAuth } = require('../../../backend/src/middleware/authenticate.js');
const { createAuthStore } = require('../../../backend/src/repositories/auth-store.js');
const { createSessions } = require('../../../backend/src/services/auth/sessions.js');
const { createAuthRoutes } = require('../../../backend/src/routes/auth.js');
const { createLimiter, AUTH_LIMIT } = require('../../../backend/src/middleware/rate-limit.js');
const { createNotify } = require('../../../backend/src/services/auth/notify.js');
const { createInvites } = require('../../../backend/src/services/auth/invites.js');
const { hashPassword } = require('../../../backend/src/services/auth/password.js');
const { codeAt, base32Decode } = require('../../../backend/src/services/auth/totp.js');
const { createSealer } = require('../../../backend/src/crypto/seal.js');
const { createPool } = require('../../../backend/src/db/pool.js');
const { migrate, pgClient } = require('../../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../../backend/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const PASS = 'correct horse battery staple';
const PUBLIC = 'https://profiler.example.com';

test.describe('links and requests', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_links_' + crypto.randomBytes(4).toString('hex');
  const PW = require('./test-db.js').TEST_ROLE_PASSWORD; // one password for every test file of a run
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  let admin, pool, store, sessions, server, base, sam, sent, invites;
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const now = () => clock.t;

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    await asRole('hwp_owner', async c => {
      sam = (await c.query(`insert into users (email, name, password_hash) values ('sam@example.com', 'Sam Adviser', $1) returning id`, [await hashPassword(PASS)])).rows[0].id;
      await c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [sam, DEFAULT_FIRM_ID]);
    });
    pool = createPool(urlFor('hwp_app'), 2);
    store = createAuthStore({ pool, now: () => new Date(clock.t) });
    sessions = createSessions({ store, secret: crypto.randomBytes(32), secure: false, now });
    sent = [];
    const mailer = { send: async m => { sent.push(m); return { delivered: true, logged: false }; } };
    const notify = createNotify({ mailer, publicUrl: PUBLIC, operatorEmail: 'operator@example.com', appName: 'Household Wealth Profiler' });
    invites = createInvites({ authStore: store, notify, now });
    const { authenticate } = createAuth({ users: new Map(), clientIpHeader: 'x-client-ip' }, { authStore: store, sessions });
    const authRoutes = createAuthRoutes({ authStore: store, sessions, limiter: createLimiter({ ...AUTH_LIMIT, now }), notify, clientIpHeader: 'x-client-ip', now, sealer: createSealer(Buffer.alloc(32, 7)), issuer: 'Household Wealth Profiler', breached: { fetch: async () => ({ ok: true, text: async () => '00000:1\n' }) } });
    const households = { list: async () => [], create: async () => ({ id: '0', version: 1 }), get: async () => null, audit: async () => null, save: async () => ({ notFound: true }) };
    const firm = { get: async () => ({ version: 0, settings: {}, updatedAt: '', updatedBy: '' }), audit: async () => [], save: async () => ({ version: 1, changes: 1 }) };
    ({ server } = createApp({ config: { hsts: false, key: Buffer.alloc(32, 7), root: ROOT, users: new Map() }, households, firm, prices: { enabled: false }, authenticate, authRoutes, ready: async () => {} }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 120000 });
  test.after(async () => { if (server) server.close(); if (pool) await pool.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });
  test.beforeEach(() => { clock.t += 16 * 60e3; sent.length = 0; });

  const J = { 'Content-Type': 'application/json' };
  const post = (p, body, { cookie, csrf, ip = '10.0.0.1' } = {}) => fetch(base + p, { method: 'POST', headers: { ...J, 'X-Client-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) });
  const get = (p, { cookie, ip = '10.0.0.1' } = {}) => fetch(base + p, { headers: { 'X-Client-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
  const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
  const events = async email => (await asRole('hwp_owner', c => c.query('select event, outcome from auth_events where email = $1 order by id', [email]))).rows.map(e => e.event + ':' + e.outcome);
  const linkIn = (text, kind) => { const m = new RegExp(PUBLIC.replace(/\./g, '\\.') + '/#' + kind + '=([A-Za-z0-9_-]{43})').exec(text); assert.ok(m, 'a link in the email: ' + text); return m[1]; };

  test('forgot password: the same 200 for any email; a known, active account gets a link by email with the token only in the fragment; events say what happened', async () => {
    for (const email of ['nobody@example.com', 'SAM@example.com']) {
      const r = await post('/api/auth/forgot', { email });
      assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    }
    assert.equal(sent.length, 1, 'one email, for the account that exists');
    assert.equal(sent[0].to, 'sam@example.com'); assert.equal(sent[0].subject, 'Reset your Household Wealth Profiler password');
    const token = linkIn(sent[0].text, 'reset');
    assert.ok(!sent[0].text.includes('?'), 'no query string: the token travels in the fragment, which browsers never send');
    assert.match(sent[0].text, /30 minutes/);
    assert.deepEqual(await events('nobody@example.com'), ['reset_requested:unknown']);
    assert.deepEqual((await events('sam@example.com')).slice(-1), ['reset_requested:sent']);
    const stored = (await asRole('hwp_owner', c => c.query(`select token_hash, purpose, used_at from one_time_tokens where user_id = $1`, [sam]))).rows;
    assert.equal(stored.length, 1); assert.equal(stored[0].purpose, 'reset'); assert.equal(stored[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'), 'stored hashed');
    for (const bad of [{}, { email: 7 }, { email: 'x'.repeat(300) }]) assert.equal((await post('/api/auth/forgot', bad)).status, 400);
  });

  test('a reset link: single use, 30 minutes, a newer one invalidates older ones; it sets the password, ends every session and is recorded', async () => {
    await post('/api/auth/forgot', { email: 'sam@example.com' });
    const older = linkIn(sent[0].text, 'reset');
    await post('/api/auth/forgot', { email: 'sam@example.com' });
    const token = linkIn(sent[1].text, 'reset');
    let r = await post('/api/auth/reset', { token: older, password: 'a wholly new passphrase 1' });
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'This link is no longer valid. Ask for a new one.', code: 'bad_token' });
    r = await post('/api/auth/reset', { token, password: 'short' });
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Use at least 12 characters', code: 'weak_password' });
    const open = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    r = await post('/api/auth/reset', { token, password: 'a wholly new passphrase 1' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await get('/api/me', { cookie: open.cookie.split(';')[0] })).status, 401, 'every session ended');
    assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS })).status, 401, 'the old password is gone');
    assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: 'a wholly new passphrase 1' })).status, 200);
    r = await post('/api/auth/reset', { token, password: 'a wholly new passphrase 2' });
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'bad_token', 'used once');
    assert.deepEqual((await asRole('hwp_owner', c => c.query("select outcome, email from auth_events where event = 'reset' order by id"))).rows, [{ outcome: 'bad_token', email: '' }, { outcome: 'ok', email: 'sam@example.com' }, { outcome: 'bad_token', email: '' }], 'a bad token names no account');
    await post('/api/auth/forgot', { email: 'sam@example.com' });
    const late = linkIn(sent[2].text, 'reset');
    clock.t += 31 * 60e3;
    r = await post('/api/auth/reset', { token: late, password: 'a wholly new passphrase 3' });
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'bad_token', 'expired after 30 minutes');
    assert.equal((await post('/api/auth/reset', { token: 'not-a-token', password: 'a wholly new passphrase 3' })).status, 400);
    assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: 'a wholly new passphrase 1' })).status, 200, 'the password set earlier stands');
  });

  test('an invitation: a new account receives a link, chooses a password through it, then signs in and enrols; the link is single use and 24 hours', async () => {
    const { userId } = await invites.create({ email: 'Dana@Example.com', name: 'Dana Adviser', firmId: DEFAULT_FIRM_ID, role: 'adviser', invitedBy: 'operator' });
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'dana@example.com'); assert.equal(sent[0].subject, 'Your Household Wealth Profiler account');
    const token = linkIn(sent[0].text, 'invite');
    assert.match(sent[0].text, /24 hours/);
    assert.equal((await asRole('hwp_owner', c => c.query('select password_hash from users where id = $1', [userId]))).rows[0].password_hash, null);
    assert.equal((await post('/api/auth/sign-in', { email: 'dana@example.com', password: 'a passphrase for dana 1' })).status, 401, 'nothing to sign in with yet');
    let r = await post('/api/auth/invite', { token, password: 'a passphrase for dana 1' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, email: 'dana@example.com' });
    r = await post('/api/auth/sign-in', { email: 'dana@example.com', password: 'a passphrase for dana 1' });
    assert.equal(r.status, 200); assert.equal((await r.json()).next, 'enrol');
    assert.equal((await post('/api/auth/invite', { token, password: 'a passphrase for dana 2' })).status, 400, 'used once');
    assert.deepEqual((await events('dana@example.com')).filter(e => /invite/.test(e)), ['invite_sent:ok', 'invite:ok']);
    // inviting an existing account again: a new link, nothing else changed (an existing membership keeps its role: roles are Phase 3)
    const again = await invites.create({ email: 'dana@example.com', name: 'ignored', firmId: DEFAULT_FIRM_ID, role: 'admin', invitedBy: 'operator' });
    assert.equal(again.userId, userId); assert.equal(again.created, false); assert.equal(sent.length, 2);
    assert.equal((await asRole('hwp_owner', c => c.query('select role from memberships where user_id = $1', [userId]))).rows[0].role, 'adviser', 'an invitation never changes a role');
    assert.equal((await asRole('hwp_owner', c => c.query('select name from users where id = $1', [userId]))).rows[0].name, 'Dana Adviser', 'nor a name');
    clock.t += 25 * 3600e3;
    assert.equal((await post('/api/auth/invite', { token: linkIn(sent[1].text, 'invite'), password: 'a passphrase for dana 3' })).status, 400, 'expired after 24 hours');
  });

  test('no route a signed-in user can reach approves an access request or creates an account: the sign-in route table is exactly the known set, and every plausible path is 404', async () => {
    const { createAuthRoutes: make } = require('../../../backend/src/routes/auth.js');
    const table = Object.keys(make({ authStore: store, sessions, limiter: createLimiter({ ...AUTH_LIMIT, now }), now }).routes).sort();
    assert.deepEqual(table, ['GET /api/auth/firms', 'GET /api/auth/invitations', 'GET /api/auth/state', 'POST /api/auth/enrol', 'POST /api/auth/enrol/confirm', 'POST /api/auth/firm', 'POST /api/auth/forgot', 'POST /api/auth/invitations/accept', 'POST /api/auth/invitations/decline', 'POST /api/auth/invite', 'POST /api/auth/password',
      'POST /api/auth/recovery', 'POST /api/auth/register', 'POST /api/auth/reset', 'POST /api/auth/sign-in', 'POST /api/auth/sign-out', 'POST /api/auth/sign-out-all', 'POST /api/auth/totp', 'POST /api/auth/verify', 'POST /api/auth/verify/resend'],
      'adding a route is a deliberate change to this list');
    const s = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    const opts = { cookie: s.cookie.split(';')[0], csrf: s.csrf };
    const before = (await asRole('hwp_owner', c => c.query('select count(*)::int n from users'))).rows[0].n;
    for (const [m, p] of [['POST', '/api/auth/approve'], ['POST', '/api/auth/access-requests'], ['POST', '/api/auth/create-user'], ['POST', '/api/auth/invite-user'], ['POST', '/api/auth/users'], ['POST', '/api/users'], ['POST', '/api/access-requests'], ['PUT', '/api/access-requests/1'], ['POST', '/api/members'], ['POST', '/api/invites'], ['GET', '/api/auth/access-requests'], ['GET', '/api/users']]) {
      const r = await fetch(base + p, { method: m, headers: { ...J, 'X-Client-IP': '10.0.0.1', Cookie: opts.cookie, 'X-CSRF-Token': opts.csrf }, body: m === 'GET' ? undefined : JSON.stringify({ email: 'x@example.com', name: 'X', firmId: DEFAULT_FIRM_ID, role: 'admin', id: 1, status: 'approved' }) });
      assert.equal(r.status, 404, `${m} ${p}`);
    }
    // the invitation route only redeems a link that the operator's tooling issued; a signed-in user cannot mint one
    assert.equal((await post('/api/auth/invite', { token: 'x'.repeat(43), password: 'a passphrase for nobody 1' }, opts)).status, 400);
    assert.equal((await asRole('hwp_owner', c => c.query('select count(*)::int n from users'))).rows[0].n, before, 'no account was created');
    assert.equal((await asRole('hwp_owner', c => c.query(`select count(*)::int n from access_requests where status <> 'pending'`))).rows[0].n, 0, 'no request was decided');
  });

  test('the sign-in state for a half-finished session: what the second step needs after a reload', async () => {
    const r = await post('/api/auth/sign-in', { email: 'sam@example.com', password: 'a wholly new passphrase 1' });
    const cookie = cookieOf(r), { csrf } = await r.json();
    const s = await get('/api/auth/state', { cookie });
    assert.equal(s.status, 200); assert.deepEqual(await s.json(), { stage: 'password', next: 'enrol', csrf, email: 'sam@example.com' });
    assert.equal((await get('/api/auth/state')).status, 401);
    await post('/api/auth/sign-out', {}, { cookie, csrf });
  });

  test('Registration: a firm of their own with the registrant as administrator; the address is confirmed through the link before the first sign-in; an existing address is told by email and nothing is made; fields and passwords are checked; a few per address per hour', async () => {
    const IP1 = '203.0.113.77', IP2 = '203.0.113.78'; // their own addresses: the per-address limits of earlier tests do not count here
    const before = sent.length;
    let r = await post('/api/auth/register', { name: 'New Adviser', email: 'New@Example.com', firm: 'Alder Wealth', password: 'a passphrase for new 1' }, { ip: IP1 });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.equal(sent.length, before + 1); assert.equal(sent[before].to, 'new@example.com'); assert.match(sent[before].subject, /Confirm your email/);
    const token = linkIn(sent[before].text, 'verify');
    const row = (await asRole('hwp_owner', c => c.query(`select u.name, u.email_verified_at, u.password_hash is not null as has_password, m.role, m.accepted_at is not null as accepted, f.name as firm, f.seats
      from users u join memberships m on m.user_id = u.id join firms f on f.id = m.firm_id where u.email = 'new@example.com'`))).rows[0];
    assert.deepEqual(row, { name: 'New Adviser', email_verified_at: null, has_password: true, role: 'admin', accepted: true, firm: 'Alder Wealth', seats: 5 });
    // not confirmed: the right password is refused with a clear code; a wrong one is refused as ever
    r = await post('/api/auth/sign-in', { email: 'new@example.com', password: 'a passphrase for new 1' }, { ip: IP1 });
    assert.equal(r.status, 403); assert.equal((await r.json()).code, 'email_unverified');
    r = await post('/api/auth/sign-in', { email: 'new@example.com', password: 'wrong' }, { ip: IP1 });
    assert.equal(r.status, 401); assert.equal((await r.json()).code, 'bad_credentials');
    // a new link on request, which replaces the first; the reply is the same for any address
    r = await post('/api/auth/verify/resend', { email: 'new@example.com' }, { ip: IP1 }); assert.equal(r.status, 200); assert.equal(sent.length, before + 2);
    r = await post('/api/auth/verify/resend', { email: 'nobody@example.com' }, { ip: IP1 }); assert.equal(r.status, 200); assert.equal(sent.length, before + 2, 'no email for an unknown address');
    const token2 = linkIn(sent[before + 1].text, 'verify');
    r = await post('/api/auth/verify', { token }, { ip: IP1 }); assert.equal(r.status, 400, 'the first link was replaced by the second');
    r = await post('/api/auth/verify', { token: token2 }, { ip: IP1 }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, email: 'new@example.com' });
    r = await post('/api/auth/verify', { token: token2 }, { ip: IP1 }); assert.equal(r.status, 400, 'a link works once');
    r = await post('/api/auth/sign-in', { email: 'new@example.com', password: 'a passphrase for new 1' }, { ip: IP1 });
    assert.equal(r.status, 200); const st = await r.json(); assert.equal(st.stage, 'password'); assert.equal(st.next, 'enrol');
    await post('/api/auth/sign-out', {}, { cookie: cookieOf(r), csrf: st.csrf });
    assert.deepEqual((await asRole('hwp_owner', c => c.query(`select event, outcome from auth_events where email = 'new@example.com' order by id`))).rows.map(e => e.event + ':' + e.outcome),
      ['register:ok', 'sign_in:unverified', 'sign_in:bad_password', 'verify_resent:sent', 'verify:ok', 'sign_in:ok', 'sign_out:ok']);
    // an address that already has an account: the same reply, nothing made, the holder is told
    const users = (await asRole('hwp_owner', c => c.query('select count(*)::int n from users'))).rows[0].n;
    r = await post('/api/auth/register', { name: 'Imposter', email: 'sam@example.com', firm: 'Other', password: 'a passphrase for sam 2' }, { ip: IP2 });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.equal(sent[sent.length - 1].to, 'sam@example.com'); assert.match(sent[sent.length - 1].subject, /already has an account/);
    assert.equal((await asRole('hwp_owner', c => c.query('select count(*)::int n from users'))).rows[0].n, users);
    for (const bad of [{ name: '', email: 'a@b.co', firm: 'F', password: 'a passphrase that is fine 1' }, { name: 'x', email: 'not-an-email', firm: 'F', password: 'a passphrase that is fine 1' }, { name: 'x', email: 'a@b.co', firm: '', password: 'a passphrase that is fine 1' }]) {
      const b = await post('/api/auth/register', bad); assert.equal(b.status, 400, JSON.stringify(bad).slice(0, 40)); assert.equal((await b.json()).code, 'bad_request');
    }
    const weak = await post('/api/auth/register', { name: 'x', email: 'weak@example.com', firm: 'F', password: 'short' }, { ip: IP2 }); assert.equal(weak.status, 400); assert.equal((await weak.json()).code, 'weak_password');
    for (let i = 0; i < 3; i++) await post('/api/auth/register', { name: 'Again', email: `again${i}@example.com`, firm: 'F', password: 'a passphrase that is fine 1' }, { ip: '203.0.113.5' });
    r = await post('/api/auth/register', { name: 'Again', email: 'again9@example.com', firm: 'F', password: 'a passphrase that is fine 1' }, { ip: '203.0.113.5' });
    assert.equal(r.status, 429); assert.equal((await r.json()).code, 'too_many_attempts');
  });

  test('TOTP_REQUIRED=0: the password alone opens a full session in the only firm, and /api/me says the second step is off', async () => {
    const solo = (await asRole('hwp_owner', async c => (await c.query(`insert into users (email, name, password_hash, password_set_at) values ('solo@example.com', 'Solo', $1, now()) returning id`, [await hashPassword(PASS)])).rows[0].id));
    await asRole('hwp_owner', c => c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [solo, DEFAULT_FIRM_ID]));
    const { authenticate } = createAuth({ users: new Map(), clientIpHeader: 'x-client-ip' }, { authStore: store, sessions });
    const routes2 = createAuthRoutes({ authStore: store, sessions, limiter: createLimiter({ ...AUTH_LIMIT, now }), notify: {}, clientIpHeader: 'x-client-ip', now, sealer: createSealer(Buffer.alloc(32, 7)), totpRequired: false });
    const nothing = { list: async () => [], create: async () => ({ id: '0', version: 1 }), get: async () => null, audit: async () => null, save: async () => ({ notFound: true }) };
    const app2 = createApp({ config: { hsts: false, key: Buffer.alloc(32), root: ROOT, users: new Map(), totpRequired: false }, households: nothing, firm: { get: async () => ({}), audit: async () => [], save: async () => ({}) }, prices: { enabled: false }, authenticate, authRoutes: routes2, ready: async () => {} });
    await new Promise(ok => app2.server.listen(0, '127.0.0.1', ok));
    const b2 = `http://127.0.0.1:${app2.server.address().port}`;
    try {
      const r = await fetch(b2 + '/api/auth/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-IP': '10.0.0.9' }, body: JSON.stringify({ email: 'solo@example.com', password: PASS }) });
      assert.equal(r.status, 200); const st = await r.json();
      assert.equal(st.stage, 'full'); assert.equal(st.next, null); assert.equal(st.firmId, DEFAULT_FIRM_ID);
      const me = await fetch(b2 + '/api/me', { headers: { Cookie: cookieOf(r) } });
      assert.equal(me.status, 200); const j = await me.json(); assert.equal(j.totpRequired, false); assert.equal(j.stage, 'full'); assert.equal(j.email, 'solo@example.com');
      assert.match((await asRole('hwp_owner', c => c.query(`select detail from auth_events where email = 'solo@example.com' and event = 'sign_in'`))).rows[0].detail, /second step off/);
      await fetch(b2 + '/api/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOf(r), 'X-CSRF-Token': st.csrf }, body: '{}' });
    } finally { app2.server.close(); }
  });
});
