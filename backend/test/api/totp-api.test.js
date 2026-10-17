// The second step of sign-in on PostgreSQL: enrolling an authenticator app, confirming it (which
// hands out recovery codes), entering a code at sign-in (never twice), signing in with a recovery
// code (which forces re-enrolment, ends other sessions, warns the user), changing the password,
// and choosing a firm once the second step is done. Runs when TEST_DATABASE_URL points at a
// scratch database, in a schema of its own.
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
const { hashPassword } = require('../../../backend/src/services/auth/password.js');
const { codeAt, base32Decode } = require('../../../backend/src/services/auth/totp.js');
const { createSealer } = require('../../../backend/src/crypto/seal.js');
const { createPool } = require('../../../backend/src/db/pool.js');
const { migrate, pgClient } = require('../../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../../backend/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const FIRM_B = '0f1e0000-0000-4000-8000-00000000000b';
const PASS = 'correct horse battery staple';

test.describe('second step API', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_totp_' + crypto.randomBytes(4).toString('hex');
  const PW = require('./test-db.js').TEST_ROLE_PASSWORD; // one password for every test file of a run
  const KEY = crypto.randomBytes(32);
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  let admin, pool, store, sessions, server, base, sam, pat, notified, breachedHit;
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const now = () => clock.t;
  const stepNow = () => Math.floor(clock.t / 1000 / 30);

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    const hash = await hashPassword(PASS);
    await asRole('hwp_owner', async c => {
      await c.query(`insert into firms (id, name) values ($1, 'Firm B')`, [FIRM_B]);
      sam = (await c.query(`insert into users (email, name, password_hash) values ('sam@example.com', 'Sam', $1) returning id`, [hash])).rows[0].id;
      await c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [sam, DEFAULT_FIRM_ID]);
      pat = (await c.query(`insert into users (email, name, password_hash) values ('pat@example.com', 'Pat', $1) returning id`, [hash])).rows[0].id;
      await c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser'), ($1, $3, 'admin')`, [pat, DEFAULT_FIRM_ID, FIRM_B]);
    });
    pool = createPool(urlFor('hwp_app'), 2);
    store = createAuthStore({ pool, now: () => new Date(clock.t) });
    sessions = createSessions({ store, secret: crypto.randomBytes(32), secure: false, now });
    notified = []; breachedHit = 0;
    const notify = { lockoutWarning: async () => {}, recoveryUsed: async user => { notified.push(['recovery', user.email]); } };
    const fetchBreached = async () => ({ ok: true, text: async () => breachedHit ? `${crypto.createHash('sha1').update('a brand new passphrase 42').digest('hex').toUpperCase().slice(5)}:${breachedHit}\n` : '00000:1\n' });
    const { authenticate } = createAuth({ users: new Map(), clientIpHeader: 'x-client-ip' }, { authStore: store, sessions });
    const authRoutes = createAuthRoutes({ authStore: store, sessions, limiter: createLimiter({ ...AUTH_LIMIT, now }), notify, clientIpHeader: 'x-client-ip', now, sealer: createSealer(KEY), issuer: 'Household Wealth Profiler', breached: { fetch: fetchBreached } });
    const households = { list: async ctx => [{ id: ctx.firmId }], create: async () => ({ id: '0', version: 1 }), get: async () => null, audit: async () => null, save: async () => ({ notFound: true }) };
    const firm = { get: async () => ({ version: 0, settings: {}, updatedAt: '', updatedBy: '' }), audit: async () => [], save: async () => ({ version: 1, changes: 1 }) };
    ({ server } = createApp({ config: { hsts: false, key: KEY, root: ROOT, users: new Map() }, households, firm, prices: { enabled: false }, authenticate, authRoutes, ready: async () => {} }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 120000 });
  test.after(async () => { if (server) server.close(); if (pool) await pool.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });
  test.beforeEach(() => { clock.t += 16 * 60e3; });

  const J = { 'Content-Type': 'application/json' };
  const post = (p, body, { cookie, csrf, ip = '10.0.0.1' } = {}) => fetch(base + p, { method: 'POST', headers: { ...J, 'X-Client-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) });
  const get = (p, { cookie, ip = '10.0.0.1' } = {}) => fetch(base + p, { headers: { 'X-Client-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
  const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
  const events = async email => (await asRole('hwp_owner', c => c.query('select event, outcome from auth_events where email = $1 order by id', [email]))).rows.map(e => e.event + ':' + e.outcome);
  // A sign-in up to the password step: { cookie, csrf, next }
  const signIn = async (email, password = PASS) => { const r = await post('/api/auth/sign-in', { email, password }); assert.equal(r.status, 200, email); const j = await r.json(); return { cookie: cookieOf(r), csrf: j.csrf, next: j.next }; };
  let samSecret, samRecovery;

  test('first sign-in: enrol an authenticator (secret shown once, sealed at rest), confirm with a code, receive recovery codes, land in the only firm', async () => {
    const s = await signIn('sam@example.com');
    assert.equal(s.next, 'enrol');
    let r = await post('/api/auth/totp', { code: '123456' }, s);
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Set up your authenticator app first', code: 'enrol_required' });
    r = await post('/api/auth/enrol', {}, s);
    assert.equal(r.status, 200);
    const e = await r.json();
    assert.deepEqual(Object.keys(e).sort(), ['secret', 'uri']);
    assert.match(e.secret, /^[A-Z2-7]{32}$/); assert.equal(e.uri, `otpauth://totp/Household%20Wealth%20Profiler:sam%40example.com?secret=${e.secret}&issuer=Household%20Wealth%20Profiler&algorithm=SHA1&digits=6&period=30`);
    samSecret = base32Decode(e.secret);
    const row = (await asRole('hwp_owner', c => c.query('select totp_pending, totp_secret, totp_confirmed_at from users where id = $1', [sam]))).rows[0];
    assert.match(row.totp_pending, /^enc:v1:/); assert.ok(!row.totp_pending.includes(e.secret), 'sealed, never in clear'); assert.equal(row.totp_secret, null); assert.equal(row.totp_confirmed_at, null);
    r = await post('/api/auth/enrol/confirm', { code: '000000' }, s);
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'That code is not right. Check the time on your phone and try the next code.', code: 'bad_code' });
    assert.equal((await get('/api/me', { cookie: s.cookie })).status, 401, 'still not in');
    r = await post('/api/auth/enrol/confirm', { code: codeAt(samSecret, stepNow()) }, s);
    assert.equal(r.status, 200);
    const c = await r.json();
    assert.deepEqual(Object.keys(c).sort(), ['csrf', 'firmId', 'firmName', 'next', 'recoveryCodes', 'role', 'roles', 'stage']);
    assert.equal(c.stage, 'full'); assert.equal(c.next, null); assert.equal(c.firmId, DEFAULT_FIRM_ID); assert.equal(c.role, 'adviser');
    assert.equal(c.recoveryCodes.length, 10); for (const code of c.recoveryCodes) assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    samRecovery = c.recoveryCodes;
    const cookie = cookieOf(r);
    assert.notEqual(cookie, s.cookie, 'the session id was rotated at the stage change');
    const me = await (await get('/api/me', { cookie })).json();
    assert.equal(me.stage, 'full'); assert.equal(me.firmId, DEFAULT_FIRM_ID); assert.equal(me.csrf, c.csrf);
    assert.equal((await get('/api/households', { cookie })).status, 200);
    const stored = (await asRole('hwp_owner', c => c.query('select totp_pending, totp_secret, totp_confirmed_at, totp_last_step, (select count(*)::int from recovery_codes where user_id = $1 and used_at is null) as codes from users where id = $1', [sam]))).rows[0];
    assert.equal(stored.totp_pending, null); assert.match(stored.totp_secret, /^enc:v1:/); assert.ok(stored.totp_confirmed_at); assert.equal(+stored.totp_last_step, stepNow()); assert.equal(stored.codes, 10);
    assert.ok(!(await asRole('hwp_owner', c => c.query('select code_hash from recovery_codes where user_id = $1', [sam]))).rows.some(x => samRecovery.includes(x.code_hash)), 'recovery codes are stored hashed');
    assert.deepEqual((await events('sam@example.com')).slice(-3), ['enrol:started', 'enrol:bad_code', 'enrol:confirmed']);
    assert.equal((await post('/api/auth/sign-out', {}, { cookie, csrf: c.csrf })).status, 200);
  });

  test('later sign-ins: a code from the app; a wrong code counts as a failure; a code is never accepted twice; a stale code is refused', async () => {
    const s = await signIn('sam@example.com');
    assert.equal(s.next, 'totp');
    let r = await post('/api/auth/totp', { code: '000000' }, s);
    assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'That code is not right', code: 'bad_code' });
    assert.equal((await asRole('hwp_owner', c => c.query('select failed_attempts from users where id = $1', [sam]))).rows[0].failed_attempts, 1, 'a wrong code counts towards the progressive delay');
    const code = codeAt(samSecret, stepNow());
    r = await post('/api/auth/totp', { code: code.slice(0, 3) + ' ' + code.slice(3) }, s);
    assert.equal(r.status, 200);
    const j = await r.json(); assert.equal(j.stage, 'full'); assert.equal(j.firmId, DEFAULT_FIRM_ID); assert.equal(j.next, null);
    const cookie = cookieOf(r);
    assert.equal((await get('/api/me', { cookie })).status, 200);
    assert.equal((await asRole('hwp_owner', c => c.query('select failed_attempts from users where id = $1', [sam]))).rows[0].failed_attempts, 0, 'cleared by the success');
    // the same code again, from a second sign-in in the same half minute: replay refused
    const s2 = await signIn('sam@example.com');
    r = await post('/api/auth/totp', { code }, s2);
    assert.equal(r.status, 401); assert.equal((await r.json()).code, 'bad_code');
    assert.ok((await events('sam@example.com')).includes('totp:replay'));
    r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow() - 2) }, s2);
    assert.equal(r.status, 401, 'a code two steps old');
    clock.t += 30e3;
    r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow()) }, s2);
    assert.equal(r.status, 200, 'the next step is new');
    // a full session cannot call the second step again; a password-stage session cannot reach data
    r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow()) }, { cookie: cookieOf(r), csrf: (await r.json()).csrf });
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'already_signed_in');
    for (const c of [cookie, cookieOf(r)]) await post('/api/auth/sign-out', {}, { cookie: c, csrf: (await (await get('/api/me', { cookie: c })).json()).csrf });
  });

  test('a recovery code signs in once, ends every other session, forces a new authenticator, warns the user and is recorded', async () => {
    const other = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    const s = await signIn('sam@example.com');
    let r = await post('/api/auth/recovery', { code: 'zzzzz-zzzzz' }, s);
    assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'That recovery code is not right', code: 'bad_code' });
    r = await post('/api/auth/recovery', { code: samRecovery[3].toUpperCase().replace('-', '') }, s);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.stage, 'full'); assert.equal(j.next, 'enrol'); assert.equal(j.firmId, DEFAULT_FIRM_ID);
    const cookie = cookieOf(r);
    assert.equal((await get('/api/me', { cookie: other.cookie.split(';')[0] })).status, 401, 'the other session has ended');
    assert.equal((await get('/api/households', { cookie })).status, 200, 'this session reaches data (the account holder proved possession of a recovery code)');
    assert.deepEqual(notified, [['recovery', 'sam@example.com']]);
    assert.ok((await events('sam@example.com')).includes('recovery:ok'));
    r = await post('/api/auth/recovery', { code: samRecovery[3] }, await signIn('sam@example.com'));
    assert.equal(r.status, 401, 'a recovery code works once');
    const again = await signIn('sam@example.com');
    assert.equal(again.next, 'enrol', 'until a new authenticator is set up, the password step leads to enrolment');
    r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow()) }, again);
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'enrol_required', 'the old authenticator no longer counts');
    r = await post('/api/auth/enrol', {}, again); const e = await r.json(); samSecret = base32Decode(e.secret);
    r = await post('/api/auth/enrol/confirm', { code: codeAt(samSecret, stepNow()) }, again);
    assert.equal(r.status, 200); const c = await r.json(); samRecovery = c.recoveryCodes;
    assert.equal((await asRole('hwp_owner', cl => cl.query('select count(*)::int n from recovery_codes where user_id = $1 and used_at is null', [sam]))).rows[0].n, 10, 'a fresh set of ten; the old set is gone');
    await post('/api/auth/sign-out', {}, { cookie: cookieOf(r), csrf: c.csrf });
    await post('/api/auth/sign-out', {}, { cookie, csrf: j.csrf });
  });

  test('changing the password: the current one is checked, the policy and the breach list apply, other sessions end, this one is rotated', async () => {
    const s = await signIn('sam@example.com');
    let r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow()) }, s);
    assert.equal(r.status, 200); let cookie = cookieOf(r), csrf = (await r.json()).csrf;
    const other = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    r = await post('/api/auth/password', { current: 'not the password', next: 'a brand new passphrase 42' }, { cookie, csrf });
    assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'The current password is not right', code: 'bad_credentials' });
    r = await post('/api/auth/password', { current: PASS, next: 'short' }, { cookie, csrf });
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Use at least 12 characters', code: 'weak_password' });
    breachedHit = 3;
    r = await post('/api/auth/password', { current: PASS, next: 'a brand new passphrase 42' }, { cookie, csrf });
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'That password has appeared in a data breach. Choose a different one.', code: 'breached_password' });
    breachedHit = 0;
    r = await post('/api/auth/password', { current: PASS, next: 'a brand new passphrase 42' }, { cookie, csrf });
    assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.ok, true); assert.notEqual(j.csrf, csrf);
    assert.notEqual(cookieOf(r), cookie, 'this session was rotated'); cookie = cookieOf(r); csrf = j.csrf;
    assert.equal((await get('/api/me', { cookie })).status, 200, 'and still works');
    assert.equal((await get('/api/me', { cookie: other.cookie.split(';')[0] })).status, 401, 'the other session has ended');
    assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: PASS })).status, 401, 'the old password is gone');
    assert.equal((await post('/api/auth/sign-in', { email: 'sam@example.com', password: 'a brand new passphrase 42' })).status, 200);
    assert.ok((await events('sam@example.com')).includes('password_change:ok'));
    await post('/api/auth/sign-out', {}, { cookie, csrf });
  });

  test('a member of several firms chooses one after the second step; until then the data routes are refused', async () => {
    const s = await signIn('pat@example.com');
    let r = await post('/api/auth/enrol', {}, s); const secret = base32Decode((await r.json()).secret);
    r = await post('/api/auth/enrol/confirm', { code: codeAt(secret, stepNow()) }, s);
    assert.equal(r.status, 200);
    const c = await r.json(); assert.equal(c.stage, 'full'); assert.equal(c.next, 'firm'); assert.equal(c.firmId, null);
    const cookie = cookieOf(r);
    const me = await (await get('/api/me', { cookie })).json(); assert.equal(me.firmId, null); assert.equal(me.stage, 'full');
    r = await get('/api/households', { cookie });
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'Choose a firm to work in', code: 'firm_required' });
    assert.deepEqual((await (await get('/api/auth/firms', { cookie })).json()).map(f => f.firmId), [DEFAULT_FIRM_ID, FIRM_B]);
    r = await post('/api/auth/firm', { firmId: FIRM_B }, { cookie, csrf: c.csrf });
    assert.equal(r.status, 200);
    assert.deepEqual(await (await get('/api/households', { cookie: cookieOf(r) })).json(), [{ id: FIRM_B }], 'data routes see the chosen firm');
  });

  // An existing account that another firm invited: the invitation is answered at sign-in, before anything is chosen for the person
  async function invitedUser(email, memberships) {
    const hash = await hashPassword(PASS);
    return asRole('hwp_owner', async c => {
      const id = (await c.query(`insert into users (email, name, password_hash) values ($1, 'Invited', $2) returning id`, [email, hash])).rows[0].id;
      for (const [firm, accepted] of memberships) await c.query(`insert into memberships (user_id, firm_id, role, extra_roles, accepted_at) values ($1, $2, 'adviser', array['compliance'], $3)`, [id, firm, accepted ? new Date(clock.t) : null]);
      return id;
    });
  }
  const finishEnrol = async email => {
    const s = await signIn(email); assert.equal(s.next, 'enrol');
    let r = await post('/api/auth/enrol', {}, s); const secret = base32Decode((await r.json()).secret);
    r = await post('/api/auth/enrol/confirm', { code: codeAt(secret, stepNow()) }, s);
    assert.equal(r.status, 200);
    return { c: await r.json(), cookie: cookieOf(r) };
  };

  test('an invitation waiting at sign-in is answered before a firm is chosen; accepting opens the firm, declining closes it', async () => {
    // lee works in the default firm and has been invited to Firm B: he is not dropped into the default firm, he is asked
    await invitedUser('lee@example.com', [[DEFAULT_FIRM_ID, true], [FIRM_B, false]]);
    const { c, cookie } = await finishEnrol('lee@example.com');
    assert.equal(c.stage, 'full'); assert.equal(c.next, 'invitations'); assert.equal(c.firmId, null);
    assert.deepEqual(c.invitations.map(i => [i.firmId, i.firmName, i.role, i.roles]), [[FIRM_B, 'Firm B', 'adviser', ['adviser', 'compliance']]]);
    let r = await get('/api/households', { cookie });
    assert.equal(r.status, 403); assert.equal((await r.json()).code, 'firm_required');
    assert.equal((await (await get('/api/auth/state', { cookie })).json()).next, 'invitations', 'also after a reload');
    assert.deepEqual((await (await get('/api/auth/firms', { cookie })).json()).map(f => f.firmId), [DEFAULT_FIRM_ID], 'the invitation is not a firm yet');
    r = await post('/api/auth/firm', { firmId: FIRM_B }, { cookie, csrf: c.csrf });
    assert.equal(r.status, 403, 'the firm cannot be chosen before the invitation is accepted');
    r = await post('/api/auth/invitations/accept', { firmId: FIRM_B }, { cookie, csrf: c.csrf });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { next: 'firm' });
    assert.deepEqual((await (await get('/api/auth/firms', { cookie })).json()).map(f => [f.firmId, f.roles]), [[DEFAULT_FIRM_ID, ['adviser', 'compliance']], [FIRM_B, ['adviser', 'compliance']]]);

    // an account whose only way in is an invitation can still sign in to answer it; accepting opens that firm
    await invitedUser('ola@example.com', [[FIRM_B, false]]);
    const o = await finishEnrol('ola@example.com');
    assert.equal(o.c.next, 'invitations');
    r = await post('/api/auth/invitations/accept', { firmId: FIRM_B }, { cookie: o.cookie, csrf: o.c.csrf });
    assert.equal(r.status, 200);
    const opened = await r.json();
    assert.deepEqual([opened.stage, opened.next, opened.firmId, opened.firmName, opened.role, opened.roles], ['full', null, FIRM_B, 'Firm B', 'adviser', ['adviser', 'compliance']]);
    assert.deepEqual(await (await get('/api/households', { cookie: cookieOf(r) })).json(), [{ id: FIRM_B }]);

    // and if they decline, with nothing else to their name, there is nothing to open
    await invitedUser('kim@example.com', [[FIRM_B, false]]);
    const k = await finishEnrol('kim@example.com');
    r = await post('/api/auth/invitations/decline', { firmId: FIRM_B }, { cookie: k.cookie, csrf: k.c.csrf });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { next: 'none' });
    assert.equal((await get('/api/households', { cookie: k.cookie })).status, 403);
    assert.ok((await events('kim@example.com')).includes('invitation_declined:ok'));
    // someone with no membership and no invitation still cannot sign in
    await asRole('hwp_owner', async cl => { await cl.query(`insert into users (email, name, password_hash) values ('nobody@example.com', 'N', $1)`, [await hashPassword(PASS)]); });
    assert.equal((await post('/api/auth/sign-in', { email: 'nobody@example.com', password: PASS })).status, 401);
  });

  test('re-enrolling while signed in needs the current password and ends other sessions once confirmed', async () => {
    const s = await signIn('sam@example.com', 'a brand new passphrase 42');
    let r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow()) }, s);
    const cookie = cookieOf(r), csrf = (await r.json()).csrf;
    const other = await sessions.issue({ userId: sam, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    r = await post('/api/auth/enrol', {}, { cookie, csrf });
    assert.equal(r.status, 401); assert.equal((await r.json()).code, 'bad_credentials', 'the password is required to replace an authenticator');
    r = await post('/api/auth/enrol', { password: 'a brand new passphrase 42' }, { cookie, csrf });
    assert.equal(r.status, 200); const fresh = base32Decode((await r.json()).secret);
    assert.equal((await get('/api/me', { cookie: other.cookie.split(';')[0] })).status, 200, 'nothing changes until the new authenticator is confirmed');
    clock.t += 30e3; // a new step: the code used above was accepted and cannot be accepted again
    r = await post('/api/auth/totp', { code: codeAt(samSecret, stepNow()) }, await signIn('sam@example.com', 'a brand new passphrase 42'));
    assert.equal(r.status, 200, 'the old authenticator still signs in until the new one is confirmed');
    r = await post('/api/auth/enrol/confirm', { code: codeAt(fresh, stepNow()) }, { cookie, csrf });
    assert.equal(r.status, 200);
    assert.equal((await get('/api/me', { cookie: other.cookie.split(';')[0] })).status, 401, 'other sessions ended');
    assert.equal((await get('/api/me', { cookie: cookieOf(r) })).status, 200);
    samSecret = fresh;
  });
});
