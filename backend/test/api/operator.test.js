// The platform operator (Phase 3, 3.4) on PostgreSQL: what the operator role can and cannot touch,
// checked as the real role (hwp_operator, not a superuser, not the owner), and the operator commands.
// Runs when TEST_DATABASE_URL points at a scratch database, in a schema of its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const operator = require('../../../backend/src/cli/platform.js');
const { createUser, setPassword } = require('../../../backend/src/cli/accounts.js');
const { createStore } = require('../../../backend/src/repositories');
const { createSealer } = require('../../../backend/src/crypto/seal.js');
const { createAuthStore } = require('../../../backend/src/repositories/auth-store.js');
const { createSessions } = require('../../../backend/src/services/auth/sessions.js');
const { migrate, pgClient } = require('../../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../../backend/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const RECORD_TABLES = ['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'idempotency_keys', 'access_log', 'household_retention', 'purge_requests'];

test.describe('platform operator', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_oper_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  const op = (sql, params) => asRole('hwp_operator', c => c.query(sql, params));
  const owner = (sql, params) => asRole('hwp_owner', c => c.query(sql, params));
  const denied = (sql, params) => assert.rejects(op(sql, params), /permission denied/, sql);
  const OP_URL = () => urlFor('hwp_operator');
  let admin, store, authStore, sessions, userId;

  // Runs a command and returns what it printed
  async function run(fn, opts) {
    const out = [], err = [], log = console.log, error = console.error;
    console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' '));
    try { const code = await fn(opts); return { code, out: out.join('\n'), err: err.join('\n') }; } finally { console.log = log; console.error = error; }
  }
  const privileges = async () => (await owner(`select 'table' as k, table_name as t, privilege_type as p from information_schema.role_table_grants where grantee = 'hwp_operator' and table_schema = $1
      union all select 'column', table_name || '.' || column_name, privilege_type from information_schema.role_column_grants where grantee = 'hwp_operator' and table_schema = $1 order by 1, 2, 3`, [schema])).rows;

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    store = createStore({ databaseUrl: urlFor('hwp_app'), databasePoolMax: 3, root: ROOT }, createSealer(crypto.randomBytes(32)));
    await store.ready();
    authStore = createAuthStore({ pool: store.pool });
    sessions = createSessions({ store: authStore, secret: crypto.randomBytes(32), secure: false });
    // Something in every table the operator must not reach: a household with its audit trail, firm settings, an account with secrets
    const rec = { id: crypto.randomUUID(), version: 1, state: { household: { name: 'Secret household', reference: 'S-1' } }, createdAt: '2026-10-10T09:00:00.000Z', createdBy: 'sam', updatedAt: '2026-10-10T09:00:00.000Z', updatedBy: 'sam' };
    await store.forFirm(DEFAULT_FIRM_ID).create(rec, [{ ts: rec.createdAt, user: 'sam', field: 'created', from: '', to: 'Secret household' }]);
    userId = (await owner(`insert into users (email, name, password_hash, totp_secret) values ('lee@example.com', 'Lee', 'scrypt$hash', 'enc:v1:secret') returning id`)).rows[0].id;
    await owner(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'admin')`, [userId, DEFAULT_FIRM_ID]);
    await owner(`insert into recovery_codes (user_id, code_hash) values ($1, 'abc')`, [userId]);
  }, { timeout: 180000 });
  test.after(async () => { if (store) await store.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });

  test('before it is granted, the operator role can read nothing', async () => {
    // without a grant on the schema, PostgreSQL does not even find the tables
    for (const sql of ['select id from firms', 'select id from users', 'select id from households'])
      await assert.rejects(op(sql), /permission denied|does not exist/, sql);
  });

  test('grant-operator: refuses without the owner connection or without the role; otherwise applies db/operator.sql', async () => {
    let r = await run(operator.grantOperator, { ownerUrl: '' });
    assert.equal(r.code, 1); assert.match(r.err, /DATABASE_OWNER_URL/);
    r = await run(operator.grantOperator, { ownerUrl: urlFor('hwp_owner'), sql: `do $$ begin raise exception 'create the hwp_operator role first (see the README)'; end $$;` });
    assert.equal(r.code, 1); assert.match(r.err, /create the hwp_operator role first/);
    r = await run(operator.grantOperator, { ownerUrl: urlFor('hwp_owner') });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /no client records/);
  });

  test('the operator manages firms, accounts and memberships', async () => {
    assert.equal((await op('select id, name, status, seats from firms')).rowCount >= 1, true);
    const f = crypto.randomUUID();
    await op(`insert into firms (id, name, seats) values ($1, 'Operator firm', 3)`, [f]);
    await op(`update firms set seats = 4, status = 'suspended', name = 'Renamed' where id = $1`, [f]);
    assert.deepEqual((await op('select name, seats, status from firms where id = $1', [f])).rows[0], { name: 'Renamed', seats: 4, status: 'suspended' });
    const u = (await op(`insert into users (email, name) values ('new@example.com', 'New') returning id`)).rows[0].id;
    await op(`update users set password_hash = 'scrypt$x', password_set_at = now(), failed_attempts = 0, not_before = null, active = true, name = 'New One' where id = $1`, [u]);
    await op(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [u, f]);
    await op(`update memberships set role = 'compliance', active = false where user_id = $1 and firm_id = $2`, [u, f]);
    await op(`update sessions set revoked_at = now() where firm_id = $1`, [f]);
    await op(`insert into auth_events (user_id, email, event, outcome, detail) values (null, '', 'firm_created', 'ok', 'x')`);
    assert.ok((await op('select count(*)::int n from auth_events')).rows[0].n >= 1);
    assert.ok((await op('select user_id, firm_id, stage, expires_at, revoked_at from sessions')).rows);
  });

  test('the operator cannot read or change a client record, a key, or an account\'s secrets', async () => {
    for (const t of RECORD_TABLES) {
      await denied(`select * from ${t}`);
      await denied(`select count(*) from ${t}`);
      await denied(`insert into ${t} default values`);
      await denied(`update ${t} set firm_id = firm_id`);
      await denied(`delete from ${t}`);
    }
    await denied('truncate households');
    for (const t of ['recovery_codes', 'one_time_tokens', 'access_requests', 'schema_migrations']) await denied(`select * from ${t}`);
    // columns that hold a key or a secret
    await denied('select wrapped_key from firms');
    await denied('select * from firms');
    await denied('select password_hash from users');
    await denied('select totp_secret from users');
    await denied('select totp_pending from users');
    await denied('select * from users');
    await denied('select id_hash from sessions');
    await denied('select * from sessions');
    await denied(`update users set totp_secret = null`);
    await denied(`update firms set wrapped_key = 'x'`);
    await denied(`update memberships set user_id = user_id`);
    // nothing is ever deleted, and the event log is append-only
    for (const t of ['firms', 'users', 'memberships', 'sessions', 'auth_events']) await denied(`delete from ${t}`);
    await denied('update auth_events set detail = detail');
    await denied('delete from auth_events');
    // belt and braces: the policies of the record tables name no operator, so a grant by mistake would still show nothing
    const policies = (await owner(`select tablename, roles::text r from pg_policies where schemaname = $1 and tablename = any($2)`, [schema, RECORD_TABLES])).rows;
    assert.ok(policies.length > 0 && policies.every(p => !/hwp_operator/.test(p.r)), 'no policy on a record table mentions the operator');
  });

  test('applying db/operator.sql again changes nothing, and removes a privilege that was added by hand', async () => {
    const before = await privileges();
    assert.ok(before.length > 10);
    assert.equal((await run(operator.grantOperator, { ownerUrl: urlFor('hwp_owner') })).code, 0);
    assert.deepEqual(await privileges(), before, 'the same set after a second run');
    await owner('grant select on households to hwp_operator');
    await owner('grant select (wrapped_key) on firms to hwp_operator');
    await op('select count(*) from households').then(() => {}, () => assert.fail('the hand-added grant should have taken effect for this check'));
    assert.equal((await run(operator.grantOperator, { ownerUrl: urlFor('hwp_owner') })).code, 0);
    assert.deepEqual(await privileges(), before, 'the extra privileges are gone');
    await denied('select count(*) from households');
    await denied('select wrapped_key from firms');
  });

  test('operator commands: create a firm, its first administrator, seats, suspend and reactivate, all recorded', async () => {
    const url = OP_URL();
    let r = await run(operator.createFirm, { url, args: ['Alder Wealth', '2'] });
    assert.equal(r.code, 0, r.err);
    const id = /Firm created: ([0-9a-f-]{36})/.exec(r.out)[1];
    assert.match(r.out, new RegExp(`create-user EMAIL "NAME" ${id} admin`));
    assert.equal((await run(operator.createFirm, { url, args: ['', '2'] })).code, 1);
    assert.equal((await run(operator.createFirm, { url, args: ['X', '0'] })).code, 1);
    assert.equal((await run(operator.createFirm, { url, args: ['X', '1.5'] })).code, 1);

    // the first administrator, with the same connection: an account, a membership, a password; none of it needs the owner
    r = await run(createUser, { ownerUrl: url, args: ['Jo@Alder.example', 'Jo Alder', id, 'admin'] });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /Account created/);
    r = await run(setPassword, { ownerUrl: url, args: ['jo@alder.example'], input: async () => 'correct horse battery staple\n' });
    assert.equal(r.code, 0, r.err); assert.equal(r.out, 'Password set for jo@alder.example.');
    const jo = (await owner(`select id, password_hash from users where email = 'jo@alder.example'`)).rows[0];
    assert.match(jo.password_hash, /^scrypt\$/);
    await run(createUser, { ownerUrl: url, args: ['sam@alder.example', 'Sam', id, 'adviser'] });

    r = await run(operator.listFirms, { url });
    assert.match(r.out, new RegExp(`${id}  active\\s+2/2 seats  Alder Wealth`));

    r = await run(operator.setSeats, { url, args: [id, '1'] });
    assert.equal(r.code, 1); assert.match(r.err, /2 people are active in Alder Wealth/);
    assert.equal((await run(operator.setSeats, { url, args: [id, '5'] })).code, 0);
    assert.equal((await run(operator.setSeats, { url, args: ['not-a-uuid', '5'] })).code, 1);
    assert.equal((await run(operator.setSeats, { url, args: [crypto.randomUUID(), '5'] })).code, 1);
    assert.match((await run(operator.listFirms, { url })).out, /2\/5 seats  Alder Wealth/);

    // suspending ends every session in the firm at once and the next request is refused; nothing is deleted
    const s = await sessions.issue({ userId: jo.id, firmId: id, stage: 'full' });
    const req = { headers: { cookie: s.cookie.split(';')[0] } };
    assert.ok(await sessions.resolve(req));
    r = await run(operator.setStatus, { url, args: [id, 'suspended'] });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /suspended; 1 session\(s\) ended\. Nothing was deleted/);
    assert.equal(await sessions.resolve(req), null);
    assert.equal((await owner('select count(*)::int n from memberships where firm_id = $1', [id])).rows[0].n, 2, 'the team is still there');
    assert.equal((await run(operator.setStatus, { url, args: [id, 'paused'] })).code, 1);
    assert.equal((await run(operator.setStatus, { url, args: [id, 'active'] })).code, 0);
    assert.ok((await authStore.memberships(jo.id)).some(m => m.firmId === id), 'access is back');

    const ev = (await owner(`select event, detail from auth_events where event like 'firm_%' order by id`)).rows.filter(e => e.detail.includes(id));
    assert.deepEqual(ev.map(e => e.event), ['firm_created', 'firm_seats', 'firm_status', 'firm_status']);
    assert.ok(ev.every(e => /by operator command/.test(e.detail)));
  });

  test('access-review lists who has access and flags what to look at', async () => {
    const id = (await owner(`select id from firms where name = 'Alder Wealth'`)).rows[0].id;
    let r = await run(operator.accessReview, { url: OP_URL(), args: [id] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Alder Wealth/);
    assert.match(r.out, /admin\s+jo@alder\.example \(Jo Alder\)\s+last sign-in never, 0 open session\(s\)\s+<- no authenticator, never signed in/);
    assert.match(r.out, /adviser\s+sam@alder\.example \(Sam\).*<- invited, not yet signed up/);
    assert.match(r.out, /2 membership\(s\) reviewed, 2 to look at/);
    assert.ok(!/password|scrypt|secret/i.test(r.out.replace(/no authenticator|invited, not yet signed up|never signed in/g, '')), 'no secret appears');
    // a firm with nobody to review, and the whole platform
    assert.match((await run(operator.accessReview, { url: OP_URL(), args: [] })).out, /Alder Wealth[\s\S]*membership\(s\) reviewed/);
    assert.equal((await run(operator.accessReview, { url: OP_URL(), args: ['nope'] })).code, 1);
  });

  test('several roles and pending invitations: create-user takes a comma-separated role list, access-review shows every role and flags an unanswered invitation', async () => {
    const url = OP_URL();
    const id = (await owner(`select id from firms where name = 'Alder Wealth'`)).rows[0].id;
    for (const bad of ['admin,admin', 'owner', 'admin,owner', ',admin', 'admin,,compliance']) {
      const r = await run(createUser, { ownerUrl: url, args: ['x@alder.example', 'X', id, bad] });
      assert.equal(r.code, 1, bad); assert.match(r.err, /ROLE one of admin, adviser, compliance/, bad);
    }
    assert.equal((await owner(`select count(*)::int n from users where email = 'x@alder.example'`)).rows[0].n, 0, 'nothing was made by the refused ones');
    let r = await run(createUser, { ownerUrl: url, args: ['Both@Alder.example', 'Both Roles', id, 'admin,compliance'] });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /\(admin\+compliance in firm /);
    assert.deepEqual((await owner(`select role, extra_roles, accepted_at is not null as accepted from memberships m join users u on u.id = m.user_id where u.email = 'both@alder.example' and m.firm_id = $1`, [id])).rows[0], { role: 'admin', extra_roles: ['compliance'], accepted: true });
    // a pending invitation (made by a firm administrator in the app) is flagged until the person answers; the operator can see it, and can grant access outright
    await owner(`update memberships set accepted_at = null where user_id = (select id from users where email = 'both@alder.example') and firm_id = $1`, [id]);
    r = await run(operator.accessReview, { url, args: [id] });
    assert.match(r.out, /active\s+admin\+compliance\s+both@alder\.example \(Both Roles\).*<- .*invitation not yet accepted/);
    r = await run(createUser, { ownerUrl: url, args: ['both@alder.example', 'Both Roles', id, 'admin,compliance'] });
    assert.equal(r.code, 0, r.err);
    assert.ok((await owner(`select accepted_at from memberships where user_id = (select id from users where email = 'both@alder.example') and firm_id = $1`, [id])).rows[0].accepted_at, 'the operator\'s own decision is access at once');
    assert.doesNotMatch((await run(operator.accessReview, { url, args: [id] })).out, /both@alder\.example.*invitation not yet accepted/);
    // a declined invitation is flagged too, and the operator's role can change the invitation columns but not the account's secrets
    await owner(`update memberships set accepted_at = null, declined_at = now(), active = false where user_id = (select id from users where email = 'both@alder.example') and firm_id = $1`, [id]);
    assert.match((await run(operator.accessReview, { url, args: [id] })).out, /inactive\s+admin\+compliance\s+both@alder\.example.*<- invitation declined/);
    await op(`update memberships set extra_roles = array['adviser'], accepted_at = now(), declined_at = null, active = true where firm_id = $1 and user_id = (select id from users where email = 'both@alder.example')`, [id]);
    await denied('select password_hash from users');
    // leave the firm as the later tests expect: that account is switched off, its membership kept
    await op(`update memberships set active = false where firm_id = $1 and user_id = (select id from users where email = 'both@alder.example')`, [id]);
  });

  test('the commands from the command line: no operator URL falls back to the owner with a note in development, and is refused in production', async () => {
    // the operator's machine: no DATA_KEY, no app password. Each setting is set to '' rather than left out, because the
    // settings loader fills a missing variable from the project's .env, and a developer's .env names a different database
    const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', DATABASE_URL: '', DATABASE_OWNER_URL: '', DATABASE_OPERATOR_URL: '', DATA_KEY: '', AUTH_USERS: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', DB_LOGIN_MODE: '', PUBLIC_URL: '' };
    const cli = (args, env) => spawnSync(process.execPath, ['server.js', ...args], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' });
    let r = cli(['firm-list'], { DATABASE_OPERATOR_URL: OP_URL() });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Alder Wealth/); assert.doesNotMatch(r.stderr, /Note:/);
    r = cli(['firm-list'], { DATABASE_OWNER_URL: urlFor('hwp_owner') });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /Note: DATABASE_OPERATOR_URL is not set/); assert.match(r.stdout, /Alder Wealth/);
    r = cli(['firm-list'], { DATABASE_OWNER_URL: urlFor('hwp_owner'), NODE_ENV: 'production' });
    assert.equal(r.status, 1); assert.match(r.stderr, /Set DATABASE_OPERATOR_URL/);
    r = cli(['firm-list'], {});
    assert.equal(r.status, 1); assert.match(r.stderr, /DATABASE_OPERATOR_URL/);
    // in production too, with the operator's connection alone: no app URL, no DATA_KEY
    r = cli(['firm-list'], { DATABASE_OPERATOR_URL: OP_URL(), NODE_ENV: 'production' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Alder Wealth/);
  });
});
