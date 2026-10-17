// Team management and roles on PostgreSQL (Phase 3): the membership rules (several roles, last
// administrator, seats, ending sessions, invitations that wait for the person's own acceptance), the
// database's own refusal to change another firm's team (checked as the real app role, hwp_app), and
// every role against every route over HTTP across two firms.
// Runs when TEST_DATABASE_URL points at a scratch database, in a schema of its own.
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
const { createStore } = require('../../../backend/src/repositories');
const { createSealer } = require('../../../backend/src/crypto/seal.js');
const { createHouseholdService } = require('../../../backend/src/services/households.js');
const { createFirmService } = require('../../../backend/src/services/firm.js');
const { createMemberService } = require('../../../backend/src/services/members.js');
const { migrate, pgClient } = require('../../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../../backend/src/repositories/ids.js');
const H = require('../../../packages/core/core.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();

test.describe('team management and roles', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_team_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  const owner = (sql, params) => asRole('hwp_owner', c => c.query(sql, params));
  const A = DEFAULT_FIRM_ID, B = crypto.randomUUID();
  const mails = [];
  const notify = {
    inviteLink: async (u, token, o) => { mails.push({ kind: 'invite', to: u.email, token, firmName: o.firmName }); },
    invitedToFirm: async (u, o) => { mails.push({ kind: 'invited', to: u.email, firmName: o.firmName, roles: o.roles }); },
  };
  let admin, store, authStore, sessions, members, server, base;
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const people = {}; // key -> { id, email, name }

  async function person(key, name, firm, role, { active = true } = {}) {
    const email = `${key}@example.com`;
    const r = await owner('select id from users where email = $1', [email]);
    const id = r.rows[0] ? r.rows[0].id : (await owner(`insert into users (email, name) values ($1, $2) returning id`, [email, name])).rows[0].id;
    await owner(`insert into memberships (user_id, firm_id, role, active) values ($1, $2, $3, $4)`, [id, firm, role, active]);
    people[key] = { id, email, name };
    return id;
  }
  const ctxOf = (key, firm = A) => ({ user: people[key].email, email: people[key].email, name: people[key].name, userId: people[key].id, firmId: firm, session: {}, role: null });
  const as = (key, role, firm = A, roles) => ({ ...ctxOf(key, firm), role, ...(roles ? { roles } : {}) });
  const sessionFor = async (key, firm = A) => sessions.issue({ userId: people[key].id, firmId: firm, stage: 'full' });
  const row = async (key, firm = A) => (await owner('select role, extra_roles, active, accepted_at, declined_at from memberships where user_id = $1 and firm_id = $2', [people[key].id, firm])).rows[0];
  const roleIn = async (key, firm = A) => { const r = await row(key, firm); return r && { role: r.role, active: r.active }; };
  const events = async key => (await owner('select event, detail from auth_events where user_id = $1 order by id', [people[key].id])).rows;
  const cookieReq = s => ({ headers: { cookie: s.cookie.split(';')[0] } });

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    await owner(`insert into firms (id, name, seats) values ($1, 'Firm B', 3)`, [B]);
    await owner(`update firms set name = 'Firm A', seats = 6 where id = $1`, [A]);
    await person('dana', 'Dana Admin', A, 'admin');
    await person('sam', 'Sam Adviser', A, 'adviser');
    await person('casey', 'Casey Compliance', A, 'compliance');
    await person('bea', 'Bea Admin', B, 'admin');
    await person('ben', 'Ben Adviser', B, 'adviser');
    store = createStore({ databaseUrl: urlFor('hwp_app'), databasePoolMax: 8, root: ROOT }, createSealer(crypto.randomBytes(32)));
    await store.ready();
    authStore = createAuthStore({ pool: store.pool, now: () => new Date(clock.t) });
    sessions = createSessions({ store: authStore, secret: crypto.randomBytes(32), idleMs: 30 * 60e3, absoluteMs: 12 * 3600e3, secure: false, now: () => clock.t });
    members = createMemberService({ authStore, notify });
    const households = createHouseholdService({ store, HWP: H, log: () => {} });
    const firm = createFirmService({ store, HWP: H });
    const { authenticate } = createAuth({ users: new Map(), clientIpHeader: '' }, { authStore, sessions });
    const authRoutes = createAuthRoutes({ authStore, sessions, limiter: createLimiter({ ...AUTH_LIMIT, now: () => clock.t }), now: () => clock.t });
    ({ server } = createApp({ config: { hsts: false, key: Buffer.alloc(32), root: ROOT, users: new Map() }, households, firm, prices: { enabled: false }, authenticate, authRoutes, members, publicShell: true, ready: async () => {} }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 180000 });
  test.after(async () => { if (server) server.close(); if (store) await store.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });

  // ---------- the database itself, as the real app role ----------
  test('the app role changes only a membership of the firm the transaction works in, and only its roles, active flag and invitation state', async () => {
    const run = (firmSetting, sql, params) => asRole('hwp_app', async c => {
      await c.query('begin'); await c.query(`select set_config('app.auth', 'on', true)`);
      if (firmSetting !== null) await c.query(`select set_config('app.firm_id', $1, true)`, [firmSetting]);
      try { return await c.query(sql, params); } finally { await c.query('rollback'); }
    });
    const bump = `update memberships set role = 'compliance', extra_roles = array['adviser'] where user_id = $1`;
    assert.equal((await run(A, bump, [people.sam.id])).rowCount, 1, 'own firm: allowed');
    assert.equal((await run(A, bump, [people.ben.id])).rowCount, 0, 'another firm: nothing changes');
    assert.equal((await run(B, bump, [people.sam.id])).rowCount, 0, 'working for the other firm: nothing changes');
    assert.equal((await run(null, bump, [people.sam.id])).rowCount, 0, 'no firm set: fails closed');
    assert.equal((await run('', bump, [people.sam.id])).rowCount, 0, 'empty firm setting: fails closed');
    for (const col of ['accepted_at = null', 'declined_at = now()']) {
      assert.equal((await run(A, `update memberships set ${col} where user_id = $1`, [people.sam.id])).rowCount, 1, `${col} for its own firm`);
      assert.equal((await run(B, `update memberships set ${col} where user_id = $1`, [people.sam.id])).rowCount, 0, `${col} for another firm's: nothing`);
    }
    await assert.rejects(run(A, `update memberships set firm_id = $2 where user_id = $1`, [people.sam.id, B]), /permission denied/);
    await assert.rejects(run(A, `update memberships set user_id = $2 where user_id = $1`, [people.sam.id, people.ben.id]), /permission denied/);
    await assert.rejects(run(A, `update memberships set created_at = now() where user_id = $1`, [people.sam.id]), /permission denied/);
    await assert.rejects(run(A, `delete from memberships where user_id = $1`, [people.sam.id]), /permission denied/);
    await assert.rejects(run(A, `update users set active = false where id = $1`, [people.sam.id]), /permission denied/);
    assert.equal((await run(A, `update memberships set active = false where firm_id = $1`, [B])).rowCount, 0);
    // a role that is not one of the three, or the primary role repeated among the extra ones, is refused by the table itself
    await assert.rejects(run(A, `update memberships set extra_roles = array['owner'] where user_id = $1`, [people.sam.id]), /memberships_extra_roles_valid/);
    await assert.rejects(run(A, `update memberships set extra_roles = array['adviser'] where user_id = $1`, [people.sam.id]), /memberships_extra_roles_valid/);
  });

  // ---------- the store's rules ----------
  test('list: the firm\'s team with roles and seats, nothing from another firm; for administrators only', async () => {
    const r = await members.list(as('dana', 'admin'));
    assert.deepEqual(r.members.map(m => m.email).sort(), ['casey@example.com', 'dana@example.com', 'sam@example.com']);
    assert.equal(r.seats, 6); assert.equal(r.used, 3);
    assert.deepEqual(Object.keys(r.members[0]).sort(), ['active', 'createdAt', 'email', 'hasPassword', 'invitation', 'lastSignInAt', 'mfa', 'name', 'role', 'roles', 'userId']);
    assert.deepEqual(r.members.find(m => m.email === 'dana@example.com').roles, ['admin']);
    assert.ok(r.members.every(m => m.invitation === null));
    for (const bad of [as('sam', 'adviser'), as('casey', 'compliance')]) await assert.rejects(members.list(bad), e => e.status === 403 && e.code === 'forbidden');
    assert.deepEqual((await members.list(as('bea', 'admin', B))).members.map(m => m.email).sort(), ['bea@example.com', 'ben@example.com']);
  });

  test('invite: a new email gets an account, its roles and an invitation link, and is on the team at once', async () => {
    mails.length = 0;
    assert.deepEqual(await members.invite(as('dana', 'admin'), { email: 'New.Person@Example.com ', name: 'New Person', roles: ['adviser', 'compliance'] }), { ok: true });
    const m = mails.pop();
    assert.equal(m.kind, 'invite'); assert.equal(m.to, 'new.person@example.com'); assert.equal(m.firmName, 'Firm A'); assert.match(m.token, /^[A-Za-z0-9_-]{43}$/);
    const u = (await owner(`select u.id, m.role, m.extra_roles, m.active, m.accepted_at from users u join memberships m on m.user_id = u.id where u.email = 'new.person@example.com' and m.firm_id = $1`, [A])).rows[0];
    assert.equal(u.role, 'adviser'); assert.deepEqual(u.extra_roles, ['compliance']); assert.equal(u.active, true);
    assert.ok(u.accepted_at, 'a new account accepts by using its link: no separate step');
    assert.ok(await authStore.consumeToken(m.token, 'invite'), 'the emailed token is the invitation token');
    people.newp = { id: u.id, email: 'new.person@example.com', name: 'New Person' };
    assert.deepEqual((await authStore.memberships(people.newp.id)).map(f => f.roles), [['adviser', 'compliance']]);
    // the older single-role form still works
    assert.deepEqual(await members.invite(as('dana', 'admin'), { email: 'one@example.com', name: 'One', role: 'compliance' }), { ok: true });
    assert.deepEqual((await owner(`select role, extra_roles from memberships m join users u on u.id = m.user_id where u.email = 'one@example.com'`)).rows[0], { role: 'compliance', extra_roles: [] });
    // the event log cannot be cleaned up, so this account stays, deactivated, which also leaves the seats as the later tests expect
    const oneId = (await owner(`select id from users where email = 'one@example.com'`)).rows[0].id;
    await members.update(as('dana', 'admin'), oneId, { active: false });
  });

  test('invite an existing account: a pending invitation that gives no access until the person accepts it at their next sign-in', async () => {
    mails.length = 0;
    await owner(`update users set password_hash = 'x' where id = $1`, [people.ben.id]);
    assert.deepEqual(await members.invite(as('dana', 'admin'), { email: 'ben@example.com', name: 'Ben Adviser', roles: ['admin', 'compliance'] }), { ok: true }, 'the same reply as for a new account');
    assert.deepEqual(mails.pop(), { kind: 'invited', to: 'ben@example.com', firmName: 'Firm A', roles: ['admin', 'compliance'] });
    assert.equal((await owner(`select count(*)::int n from one_time_tokens where user_id = $1`, [people.ben.id])).rows[0].n, 0, 'no link: redeeming one would reset his password');
    const r = await row('ben', A);
    assert.equal(r.accepted_at, null); assert.equal(r.declined_at, null); assert.equal(r.role, 'admin'); assert.deepEqual(r.extra_roles, ['compliance']);
    assert.equal((await roleIn('ben', B)).role, 'adviser', 'his place in the other firm is untouched');
    // nothing is open to him yet: it is not a membership for sign-in, a session, or the last-administrator count
    assert.deepEqual((await authStore.memberships(people.ben.id)).map(f => f.firmId), [B]);
    assert.deepEqual((await authStore.pendingInvitations(people.ben.id)).map(f => [f.firmId, f.firmName, f.roles]), [[A, 'Firm A', ['admin', 'compliance']]]);
    const team = (await members.list(as('dana', 'admin'))).members.find(m => m.email === 'ben@example.com');
    assert.equal(team.invitation, 'pending'); assert.deepEqual(team.roles, ['admin', 'compliance']);
    assert.equal((await members.list(as('dana', 'admin'))).used, 5, 'an invitation holds a seat');
    assert.ok((await events('ben')).some(e => e.event === 'invite_sent' && /pending acceptance/.test(e.detail) && /admin\+compliance/.test(e.detail) && /dana@example\.com/.test(e.detail)));
    await assert.rejects(authStore.respondToInvitation(people.sam.id, A, true), e => e.status === 404, 'only your own invitation can be answered');
  });

  test('accepting an invitation opens the firm; declining closes it, frees the seat, and the person can be invited again', async () => {
    const s = await sessionFor('ben', B);
    assert.deepEqual(await authStore.respondToInvitation(people.ben.id, A, true), { roles: ['admin', 'compliance'] });
    assert.ok((await row('ben', A)).accepted_at);
    assert.deepEqual((await authStore.memberships(people.ben.id)).map(f => [f.firmId, f.roles]).sort(), [[A, ['admin', 'compliance']], [B, ['adviser']]].sort());
    assert.deepEqual(await authStore.pendingInvitations(people.ben.id), []);
    assert.ok(await sessions.resolve(cookieReq(s)), 'his session in Firm B is not disturbed');
    await assert.rejects(authStore.respondToInvitation(people.ben.id, A, true), e => e.status === 404, 'answered once, not twice');
    assert.ok((await events('ben')).some(e => e.event === 'invitation_accepted'));
    await owner(`delete from memberships where user_id = $1 and firm_id = $2`, [people.ben.id, A]);

    // declining: a new invitation, then no
    await members.invite(as('dana', 'admin'), { email: 'ben@example.com', name: 'Ben Adviser', roles: ['adviser'] });
    const used = (await members.list(as('dana', 'admin'))).used;
    assert.deepEqual(await authStore.respondToInvitation(people.ben.id, A, false), { roles: ['adviser'] });
    const r = await row('ben', A);
    assert.equal(r.active, false); assert.ok(r.declined_at); assert.equal(r.accepted_at, null);
    assert.equal((await members.list(as('dana', 'admin'))).used, used - 1, 'the seat is free again');
    assert.equal((await members.list(as('dana', 'admin'))).members.find(m => m.email === 'ben@example.com').invitation, 'declined');
    assert.deepEqual((await authStore.memberships(people.ben.id)).map(f => f.firmId), [B]);
    assert.ok((await events('ben')).some(e => e.event === 'invitation_declined'));
    // invited again: pending again, with the new roles
    await members.invite(as('dana', 'admin'), { email: 'ben@example.com', name: 'Ben Adviser', roles: ['compliance'] });
    const again = await row('ben', A);
    assert.equal(again.active, true); assert.equal(again.declined_at, null); assert.equal(again.accepted_at, null); assert.equal(again.role, 'compliance');
    await owner(`delete from memberships where user_id = $1 and firm_id = $2`, [people.ben.id, A]);
  });

  test('invite: refusals', async () => {
    const dana = as('dana', 'admin');
    await assert.rejects(members.invite(dana, { email: 'sam@example.com', name: 'Sam', role: 'adviser' }), e => e.status === 409 && e.code === 'already_member');
    for (const bad of [{ email: 'nope', name: 'X' }, { email: 'a@b.co', name: '' }, { email: 'a@b.co', name: 'X', role: 'owner' }, { email: 'a@b.co', name: 'X', roles: [] }, { email: 'a@b.co', name: 'X', roles: ['admin', 'admin'] },
      { email: 'a@b.co', name: 'X', roles: ['admin', 'owner'] }, { email: 'a@b.co', name: 'X', roles: 'admin' }, { email: 'a@b.co', name: 'X\u0000' }, null, {}])
      await assert.rejects(members.invite(dana, bad), e => e.status === 400 && e.code === 'bad_request', JSON.stringify(bad));
    for (const ctx of [as('sam', 'adviser'), as('casey', 'compliance'), { ...as('dana', 'admin'), role: '' }]) await assert.rejects(members.invite(ctx, { email: 'z@example.com', name: 'Z' }), e => e.status === 403);
    assert.equal((await owner(`select count(*)::int n from users where email = 'z@example.com'`)).rows[0].n, 0);
    await assert.doesNotReject(members.list(as('casey', 'compliance', A, ['compliance', 'admin'])), 'someone who is also an administrator manages the team too');
  });

  test('seats: the last seat goes to exactly one of two invitations at once; a full firm refuses with 402', async () => {
    // dana, sam, casey and the new person are active: with 4 seats the firm is full
    await owner(`update firms set seats = 4 where id = $1`, [A]);
    await assert.rejects(members.invite(as('dana', 'admin'), { email: 'late@example.com', name: 'Late', role: 'adviser' }), e => e.status === 402 && e.code === 'seats_full');
    await owner(`update firms set seats = 5 where id = $1`, [A]);
    const out = await Promise.allSettled(['r1', 'r2', 'r3'].map(k => members.invite(as('dana', 'admin'), { email: `${k}@example.com`, name: k, role: 'adviser' })));
    assert.equal(out.filter(o => o.status === 'fulfilled').length, 1, 'one seat left, one invitation');
    assert.ok(out.filter(o => o.status === 'rejected').every(o => o.reason.code === 'seats_full'));
    assert.equal((await members.list(as('dana', 'admin'))).used, 5);
    await owner(`update firms set seats = 6 where id = $1`, [A]);
  });

  test('roles: one or several, applied at once, audited with who made them, never your own, never on another firm\'s people', async () => {
    const dana = as('dana', 'admin');
    const sessionBefore = await sessionFor('sam');
    let r = await members.update(dana, people.sam.id, { roles: ['compliance'] });
    assert.deepEqual(r.roles, ['compliance']);
    assert.equal((await sessions.resolve(cookieReq(sessionBefore))).role, 'compliance', 'the role in the session is read from the database on every request');
    assert.ok((await events('sam')).some(e => e.event === 'member_role_changed' && /adviser to compliance/.test(e.detail) && /by dana@example\.com/.test(e.detail)));

    // several roles on one membership: the first is the primary role, all of them count
    r = await members.update(dana, people.sam.id, { roles: ['adviser', 'compliance'] });
    assert.deepEqual([r.role, r.roles], ['adviser', ['adviser', 'compliance']]);
    assert.deepEqual((await row('sam')).extra_roles, ['compliance']);
    const resolved = await sessions.resolve(cookieReq(sessionBefore));
    assert.equal(resolved.role, 'adviser'); assert.deepEqual(resolved.roles, ['adviser', 'compliance']);
    assert.ok((await events('sam')).some(e => e.event === 'member_role_changed' && /compliance to adviser\+compliance/.test(e.detail)));
    // the older single-role form, and putting it back
    r = await members.update(dana, people.sam.id, { role: 'adviser' });
    assert.deepEqual(r.roles, ['adviser']);
    assert.deepEqual(await members.update(dana, people.sam.id, { roles: ['adviser'] }), (await members.list(dana)).members.find(m => m.userId === people.sam.id), 'no change is not an error');

    await assert.rejects(members.update(dana, people.dana.id, { roles: ['adviser'] }), e => e.status === 400 && e.code === 'self_change');
    await assert.rejects(members.update(dana, people.dana.id, { active: false }), e => e.status === 400 && e.code === 'self_change');
    await assert.rejects(members.update(dana, people.ben.id, { roles: ['admin'] }), e => e.status === 404 && e.code === 'not_found');
    assert.equal((await roleIn('ben', B)).role, 'adviser');
    for (const bad of [{}, { role: 'owner' }, { roles: [] }, { roles: ['adviser', 'adviser'] }, { roles: ['adviser', 'owner'] }, { roles: 'adviser' }, { active: 'yes' }, { role: null }]) await assert.rejects(members.update(dana, people.sam.id, bad), e => e.status === 400, JSON.stringify(bad));
    await assert.rejects(members.update(dana, 'not-a-uuid', { role: 'adviser' }), e => e.status === 404);
    for (const ctx of [as('sam', 'adviser'), as('casey', 'compliance')]) await assert.rejects(members.update(ctx, people.sam.id, { roles: ['admin'] }), e => e.status === 403);
  });

  test('the firm always keeps an active administrator who has accepted, even when two administrators remove each other at once', async () => {
    await assert.rejects(authStore.changeMember(A, people.dana.id, { roles: ['adviser'] }), e => e.status === 409 && e.code === 'last_admin');
    await assert.rejects(authStore.changeMember(A, people.dana.id, { roles: ['compliance', 'adviser'] }), e => e.status === 409 && e.code === 'last_admin', 'dropping admin among several roles counts');
    await assert.rejects(authStore.changeMember(A, people.dana.id, { active: false }), e => e.status === 409 && e.code === 'last_admin');
    assert.equal((await authStore.changeMember(A, people.dana.id, { roles: ['admin', 'compliance'] })).changed, true, 'keeping admin among several is fine');
    await authStore.changeMember(A, people.dana.id, { roles: ['admin'] });
    // a pending invitation to be an administrator is not an administrator yet
    await owner(`insert into memberships (user_id, firm_id, role, accepted_at) values ($1, $2, 'admin', null)`, [people.ben.id, A]);
    await assert.rejects(authStore.changeMember(A, people.dana.id, { roles: ['adviser'] }), e => e.status === 409 && e.code === 'last_admin', 'the invitee has not accepted');
    await owner(`delete from memberships where user_id = $1 and firm_id = $2`, [people.ben.id, A]);
    await owner(`update memberships set role = 'admin' where user_id = $1 and firm_id = $2`, [people.sam.id, A]);
    // dana and sam are both administrators; each tries to demote the other at the same moment
    const out = await Promise.allSettled([authStore.changeMember(A, people.dana.id, { roles: ['adviser'] }), authStore.changeMember(A, people.sam.id, { roles: ['adviser'] })]);
    assert.equal(out.filter(o => o.status === 'fulfilled').length, 1);
    assert.ok(out.find(o => o.status === 'rejected').reason.code === 'last_admin');
    const left = (await owner(`select count(*)::int n from memberships where firm_id = $1 and role = 'admin' and active`, [A])).rows[0].n;
    assert.equal(left, 1);
    await owner(`update memberships set role = case when user_id = $2 then 'admin' else 'adviser' end where firm_id = $1 and user_id in ($2, $3)`, [A, people.dana.id, people.sam.id]);
  });

  test('deactivating ends that person\'s sessions in this firm at once, and not their sessions in another firm; reactivating needs a seat', async () => {
    await owner(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [people.sam.id, B]);
    const inA = await sessionFor('sam', A), inB = await sessionFor('sam', B);
    assert.ok(await sessions.resolve(cookieReq(inA))); assert.ok(await sessions.resolve(cookieReq(inB)));
    const r = await members.update(as('dana', 'admin'), people.sam.id, { active: false });
    assert.equal(r.active, false);
    assert.equal(await sessions.resolve(cookieReq(inA)), null, 'signed out of Firm A');
    assert.ok(await sessions.resolve(cookieReq(inB)), 'still signed in to Firm B');
    assert.ok((await events('sam')).some(e => e.event === 'member_deactivated' && /sessions ended/.test(e.detail)));
    // a full firm: reactivation is refused until a seat is free
    await owner(`update firms set seats = 4 where id = $1`, [A]); // four others are active
    await assert.rejects(members.update(as('dana', 'admin'), people.sam.id, { active: true }), e => e.status === 402 && e.code === 'seats_full');
    await owner(`update firms set seats = 6 where id = $1`, [A]);
    assert.equal((await members.update(as('dana', 'admin'), people.sam.id, { active: true })).active, true);
    assert.ok((await events('sam')).some(e => e.event === 'member_reactivated'));
  });

  // ---------- every role against every route, over HTTP ----------
  const J = { 'Content-Type': 'application/json' };
  const http = async (key, method, p, body, firm = A) => {
    const s = await sessionFor(key, firm);
    const r = await fetch(base + p, { method, headers: { Cookie: s.cookie.split(';')[0], ...(method === 'GET' ? {} : { ...J, 'X-CSRF-Token': s.csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  test('over HTTP: each role gets exactly what the table says, on every route', async () => {
    const st = H.sample(); st.household.reference = 'HTTP-1'; st.compliance.preparer = 'Sam Adviser';
    const created = await http('dana', 'POST', '/api/households', { state: st });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const firmRec = (await http('dana', 'GET', '/api/firm')).body;

    const expect = (status, r, what) => assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
    const rows = [['dana', 'admin'], ['sam', 'adviser'], ['casey', 'compliance']];
    for (const [key, role] of rows) {
      const write = role !== 'compliance', admin = role === 'admin';
      expect(200, await http(key, 'GET', '/api/households'), `${role} list`);
      expect(200, await http(key, 'GET', `/api/households/${id}`), `${role} open`);
      expect(200, await http(key, 'GET', `/api/households/${id}/audit`), `${role} household audit`);
      expect(200, await http(key, 'GET', '/api/firm'), `${role} firm settings`);
      expect(admin || role === 'compliance' ? 200 : 403, await http(key, 'GET', '/api/firm/audit'), `${role} firm audit`);
      expect(admin ? 200 : 403, await http(key, 'PUT', '/api/firm', { version: firmRec.version, settings: firmRec.settings }), `${role} save firm settings`);
      expect(admin ? 200 : 403, await http(key, 'GET', '/api/members'), `${role} team list`);
      expect(admin ? 400 : 403, await http(key, 'POST', '/api/members', { email: 'bad', name: 'x' }), `${role} invite`);
      expect(admin ? 404 : 403, await http(key, 'PATCH', `/api/members/${crypto.randomUUID()}`, { active: true }), `${role} change a member`);
      const probe = H.sample(); probe.household.reference = 'HTTP-' + role;
      expect(write ? 201 : 403, await http(key, 'POST', '/api/households', { state: probe }), `${role} create`);
    }
    // /api/me says every role
    const s = await sessionFor('dana');
    await owner(`update memberships set extra_roles = array['compliance'] where user_id = $1 and firm_id = $2`, [people.dana.id, A]);
    const me = await (await fetch(base + '/api/me', { headers: { Cookie: s.cookie.split(';')[0] } })).json();
    assert.deepEqual([me.role, me.roles], ['admin', ['admin', 'compliance']]);
    await owner(`update memberships set extra_roles = '{}' where user_id = $1 and firm_id = $2`, [people.dana.id, A]);
    // cross-firm: Firm B's administrator sees only Firm B's team (Sam also works there) and can reach nobody who is only in Firm A
    const bTeam = await http('bea', 'GET', '/api/members', undefined, B);
    assert.deepEqual(bTeam.body.members.map(m => m.email).sort(), ['bea@example.com', 'ben@example.com', 'sam@example.com']);
    assert.equal((await http('bea', 'PATCH', `/api/members/${people.casey.id}`, { role: 'admin' }, B)).status, 404);
    assert.equal((await roleIn('casey', A)).role, 'compliance');
    assert.equal((await http('bea', 'GET', `/api/households/${id}`, undefined, B)).status, 404, 'and cannot open Firm A\'s household');
    assert.equal((await fetch(base + '/api/members')).status, 401);
  });

  test('over HTTP: sign-off by a reviewer who holds several roles, and the file\'s state in the reply', async () => {
    const st = H.sample(); st.isSample = false; st.household.reference = 'HTTP-SO'; st.compliance.preparer = 'Sam Adviser'; Object.assign(st.compliance, { reviewer: '', reviewDate: '', outcome: 'pending', reviewNotes: '' });
    const made = await http('sam', 'POST', '/api/households', { state: st });
    assert.equal(made.status, 201);
    const id = made.body.id;
    await owner(`update memberships set extra_roles = array['compliance'] where user_id = $1 and firm_id = $2`, [people.dana.id, A]);
    const open = async key => (await http(key, 'GET', `/api/households/${id}`)).body;
    let rec = await open('dana');
    assert.equal(rec.contributors, undefined, 'never sent out');
    // Dana (admin + compliance) has not worked on the file: she signs it off; typed reviewer and date are replaced by her account and today
    rec.state.compliance.outcome = 'approved'; rec.state.compliance.reviewer = 'Someone Else';
    const put = await http('dana', 'PUT', `/api/households/${id}`, { version: rec.version, state: rec.state });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.review.by, 'Dana Admin'); assert.equal(put.body.reviewStale, false);
    rec = await open('casey');
    assert.equal(rec.state.compliance.reviewer, 'Dana Admin'); assert.equal(rec.reviewStale, false); assert.equal(rec.review.by, 'Dana Admin');
    assert.match(rec.state.compliance.reviewDate, /^\d{4}-\d\d-\d\d$/);
    // an adviser changes a client's identity details: the sign-off is out of date, said in the reply and on the record
    const edited = JSON.parse(JSON.stringify(rec.state)); edited.members[0].niNumber = 'QQ123456C';
    const e1 = await http('sam', 'PUT', `/api/households/${id}`, { version: rec.version, state: edited });
    assert.equal(e1.status, 200); assert.equal(e1.body.reviewStale, true);
    assert.equal((await open('sam')).reviewStale, true);
    // Dana now works on the file as an administrator: she can no longer sign it off again; Casey can
    rec = await open('dana'); const fix = JSON.parse(JSON.stringify(rec.state)); fix.household.region = 'Wales';
    assert.equal((await http('dana', 'PUT', `/api/households/${id}`, { version: rec.version, state: fix })).status, 200);
    rec = await open('dana'); const resign = JSON.parse(JSON.stringify(rec.state)); resign.compliance.reviewNotes = 'again';
    const refused = await http('dana', 'PUT', `/api/households/${id}`, { version: rec.version, state: resign });
    assert.equal(refused.status, 403); assert.equal(refused.body.code, 'separation_of_duties');
    const ok = await http('casey', 'PUT', `/api/households/${id}`, { version: rec.version, state: resign });
    assert.equal(ok.status, 200); assert.equal(ok.body.reviewStale, false); assert.equal(ok.body.review.by, 'Casey Compliance');
    await owner(`update memberships set extra_roles = '{}' where user_id = $1 and firm_id = $2`, [people.dana.id, A]);
  });

  test('over HTTP: the person\'s own answer to an invitation: not before sign-in, only their own, accepting opens the firm', async () => {
    // Ben has an account with a password and a place in Firm B; Dana invites him to Firm A
    await members.invite(as('dana', 'admin'), { email: 'ben@example.com', name: 'Ben Adviser', roles: ['adviser', 'compliance'] });
    // his session after the second step has no firm yet
    const s = await sessions.issue({ userId: people.ben.id, firmId: null, stage: 'full' });
    const call = (method, p, body, sess = s) => fetch(base + p, { method, headers: { Cookie: sess.cookie.split(';')[0], ...(method === 'GET' ? {} : { ...J, 'X-CSRF-Token': sess.csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await fetch(base + '/api/auth/invitations')).status, 401, 'not without a session');
    let r = await call('GET', '/api/auth/invitations');
    assert.deepEqual((await r.json()).map(i => [i.firmId, i.firmName, i.roles]), [[A, 'Firm A', ['adviser', 'compliance']]]);
    assert.equal((await (await call('GET', '/api/auth/state')).json()).next, 'invitations', 'the next step is the invitation, before any choice of firm');
    // before accepting, Firm A is closed to him: no data, and the firm cannot be chosen
    assert.equal((await call('GET', '/api/households')).status, 403);
    r = await call('POST', '/api/auth/firm', { firmId: A }); assert.equal(r.status, 403);
    // the answer needs the session's own token, and only the person's own invitation can be answered
    assert.equal((await fetch(base + '/api/auth/invitations/accept', { method: 'POST', headers: { Cookie: s.cookie.split(';')[0], ...J }, body: JSON.stringify({ firmId: A }) })).status, 403, 'CSRF');
    const sam = await sessions.issue({ userId: people.sam.id, firmId: A, stage: 'full' });
    assert.equal((await call('POST', '/api/auth/invitations/accept', { firmId: A }, sam)).status, 404, 'Sam has no invitation to Firm A');
    assert.equal((await call('POST', '/api/auth/invitations/accept', { firmId: 'nope' })).status, 400);
    assert.equal((await call('POST', '/api/auth/invitations/accept', { firmId: B })).status, 404, 'an invitation that does not exist');
    // accepting: he belongs to two firms, so he chooses; then Firm A opens with both roles
    r = await call('POST', '/api/auth/invitations/accept', { firmId: A });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { next: 'firm' });
    r = await call('POST', '/api/auth/firm', { firmId: A }); assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const switched = await r.json();
    assert.deepEqual([switched.role, switched.roles], ['adviser', ['adviser', 'compliance']]);
    assert.equal((await fetch(base + '/api/households', { headers: { Cookie: cookie } })).status, 200);
    await owner(`delete from memberships where user_id = $1 and firm_id = $2`, [people.ben.id, A]);

    // declining, with nothing else pending and one firm left, carries on into that firm
    await members.invite(as('dana', 'admin'), { email: 'ben@example.com', name: 'Ben Adviser', roles: ['adviser'] });
    const s2 = await sessions.issue({ userId: people.ben.id, firmId: null, stage: 'full' });
    r = await call('POST', '/api/auth/invitations/decline', { firmId: A }, s2);
    assert.equal(r.status, 200);
    const done = await r.json();
    assert.deepEqual([done.stage, done.next, done.firmId, done.roles], ['full', null, B, ['adviser']], 'the only firm left is opened');
    assert.deepEqual(await authStore.pendingInvitations(people.ben.id), []);
    await owner(`delete from memberships where user_id = $1 and firm_id = $2`, [people.ben.id, A]);
  });

  test('over HTTP: a write needs the session\'s CSRF token, and a deactivated or demoted person is out on their very next request', async () => {
    const s = await sessionFor('dana');
    const noToken = await fetch(base + '/api/members', { method: 'POST', headers: { Cookie: s.cookie.split(';')[0], ...J }, body: JSON.stringify({ email: 'csrf@example.com', name: 'Csrf', role: 'adviser' }) });
    assert.equal(noToken.status, 403);
    assert.equal((await owner(`select count(*)::int n from users where email = 'csrf@example.com'`)).rows[0].n, 0);

    // sam is signed in as an adviser; dana demotes him to compliance: his next create is refused, with no sign-in in between
    const sam = await sessionFor('sam');
    const create = async n => (await fetch(base + '/api/households', { method: 'POST', headers: { Cookie: sam.cookie.split(';')[0], ...J, 'X-CSRF-Token': sam.csrf }, body: JSON.stringify({ state: Object.assign(H.sample(), { household: { ...H.sample().household, reference: n } }) }) })).status;
    assert.equal(await create('LIVE-1'), 201);
    assert.equal((await http('dana', 'PATCH', `/api/members/${people.sam.id}`, { role: 'compliance' })).status, 200);
    assert.equal(await create('LIVE-2'), 403);
    assert.equal((await http('dana', 'PATCH', `/api/members/${people.sam.id}`, { roles: ['adviser', 'compliance'] })).status, 200);
    assert.equal(await create('LIVE-4'), 201, 'adviser among his roles again: allowed at once');
    assert.equal((await http('dana', 'PATCH', `/api/members/${people.sam.id}`, { active: false })).status, 200);
    assert.equal(await create('LIVE-3'), 401, 'deactivated: the session is gone');
    await http('dana', 'PATCH', `/api/members/${people.sam.id}`, { roles: ['adviser'], active: true });
  });
});
