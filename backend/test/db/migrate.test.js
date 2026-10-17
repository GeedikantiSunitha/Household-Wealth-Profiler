// db/migrate.js and the self-hosted migrations (db/migrations), in PGlite (Postgres in WebAssembly)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrate, pending } = require('../../../db/migrate.js');

const DIR = path.join(__dirname, '..', '..', '..', 'db', 'migrations');
const pglite = async () => { const { PGlite } = await import('@electric-sql/pglite'); return new PGlite(); };
const adapt = pg => ({ query: async (sql, params) => (await pg.query(sql, params)).rows, exec: sql => pg.exec(sql) });
const ID = '11111111-1111-4111-8111-111111111111';

test('a new database gets every migration once; pending() says what is still to run', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    const all = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
    assert.deepEqual(await pending(db, { dir: DIR }), all, 'everything is pending on a new database');
    assert.deepEqual(await migrate(db, { dir: DIR }), all);
    assert.deepEqual(await pending(db, { dir: DIR }), [], 'nothing pending afterwards');
    assert.deepEqual(await migrate(db, { dir: DIR }), [], 'second run does nothing');
    assert.equal((await db.query(`select to_regclass('households') is not null as ok`))[0].ok, true);
  } finally { await pg.close(); }
});

test('a database made before migrations were tracked is adopted with its data and retention rules intact', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    // What the old server.js did at start-up: run the schema directly, then save a household
    await pg.exec(fs.readFileSync(path.join(DIR, '0001_init.sql'), 'utf8'));
    await pg.query(`insert into households values ($1, 2, 'enc:v1:current', now())`, [ID]);
    await pg.query(`insert into household_versions (household_id, version, doc) values ($1, 1, 'enc:v1:one'), ($1, 2, 'enc:v1:two')`, [ID]);
    await pg.query(`insert into audit_log (household_id, entry) values ($1, 'enc:v1:a'), ($1, 'enc:v1:b')`, [ID]);

    await migrate(db, { dir: DIR });
    assert.deepEqual(await db.query(`select version, doc from households`), [{ version: 2, doc: 'enc:v1:current' }]);
    assert.deepEqual((await db.query(`select doc from household_versions order by version`)).map(r => r.doc), ['enc:v1:one', 'enc:v1:two']);
    assert.equal((await db.query(`select count(*)::int n from audit_log`))[0].n, 2);
    for (const sql of ['delete from households', 'update household_versions set doc = $$x$$', 'delete from audit_log', 'truncate household_versions'])
      await assert.rejects(pg.query(sql), /not allowed: records are kept/, sql);
  } finally { await pg.close(); }
});

const DEFAULT_FIRM = 'f1a00000-0000-4000-8000-000000000001';
const FIRM_TABLES = ['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'idempotency_keys', 'firms'];

test('0004: existing rows move into the default firm; frozen tables accept only that one change; RLS is forced; the app role sees nothing without a firm', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    // A database from before tenancy, with data in every table
    await pg.exec(fs.readFileSync(path.join(DIR, '0001_init.sql'), 'utf8'));
    await pg.exec(fs.readFileSync(path.join(DIR, '0002_firm_settings.sql'), 'utf8'));
    await pg.query(`insert into households values ($1, 2, 'enc:v1:current', now())`, [ID]);
    await pg.query(`insert into household_versions (household_id, version, doc) values ($1, 1, 'enc:v1:one'), ($1, 2, 'enc:v1:two')`, [ID]);
    await pg.query(`insert into audit_log (household_id, entry) values ($1, 'enc:v1:a'), ($1, 'enc:v1:b')`, [ID]);
    await pg.query(`insert into firm_settings (version, doc, updated_at) values (2, 'enc:v1:firm', now())`);
    await pg.query(`insert into firm_versions (version, doc) values (1, 'enc:v1:f1'), (2, 'enc:v1:f2')`);
    await pg.query(`insert into firm_audit (entry) values ('enc:v1:fa')`);

    const applied = await migrate(db, { dir: DIR });
    assert.ok(applied.includes('0004_firms.sql'), applied.join());

    // The default firm, and every existing row in it
    assert.deepEqual(await db.query(`select id, status, seats from firms`), [{ id: DEFAULT_FIRM, status: 'active', seats: 5 }]);
    for (const t of ['households', 'household_versions', 'audit_log', 'firm_audit'])
      assert.equal((await db.query(`select count(*)::int n from ${t} where firm_id = $1`, [DEFAULT_FIRM]))[0].n, (await db.query(`select count(*)::int n from ${t}`))[0].n, t + ' backfilled');
    assert.deepEqual(await db.query(`select firm_id, version, doc from firm_records`), [{ firm_id: DEFAULT_FIRM, version: 2, doc: 'enc:v1:firm' }], 'firm settings copied per firm');
    assert.deepEqual((await db.query(`select version, doc from firm_record_versions order by version`)).map(r => r.doc), ['enc:v1:f1', 'enc:v1:f2']);
    assert.equal((await db.query(`select count(*)::int n from firm_settings`))[0].n, 1, 'the old table is left as it was');

    // Frozen tables: the only change ever allowed is a firm_id filled in where it was empty
    await assert.rejects(pg.query(`update household_versions set doc = 'x'`), /not allowed: records are kept/);
    await assert.rejects(pg.query(`update household_versions set firm_id = $1`, [crypto.randomUUID()]), /not allowed: records are kept/, 'once set, firm_id is frozen too');
    await assert.rejects(pg.query(`update audit_log set entry = 'x'`), /not allowed/);
    await assert.rejects(pg.query(`delete from firm_records`), /not allowed/);
    await assert.rejects(pg.query(`update firm_record_versions set doc = 'x'`), /not allowed/);

    // Roles and row-level security
    assert.deepEqual((await db.query(`select rolsuper, rolbypassrls from pg_roles where rolname = 'hwp_app'`))[0], { rolsuper: false, rolbypassrls: false });
    const rls = await db.query(`select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = any($1) order by relname`, [FIRM_TABLES]);
    assert.equal(rls.length, FIRM_TABLES.length);
    for (const t of rls) assert.deepEqual([t.on, t.forced], [true, true], t.relname);
    for (const t of ['users', 'memberships']) assert.deepEqual((await db.query(`select relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = $1`, [t]))[0], { on: true, forced: true }, t);

    await pg.exec('set role hwp_app');
    for (const t of FIRM_TABLES) assert.equal((await db.query(`select count(*)::int n from ${t}`))[0].n, 0, `${t}: nothing without a firm`);
    const inFirm = await pg.exec(`begin; select set_config('app.firm_id', '${DEFAULT_FIRM}', true); select count(*)::int as n from households; select count(*)::int as n from firms; commit`);
    assert.equal(inFirm[2].rows[0].n, 1, 'with the firm set, its households');
    assert.equal(inFirm[3].rows[0].n, 1, 'and only its own firm row');
    assert.equal((await db.query(`select count(*)::int n from households`))[0].n, 0, 'the setting ended with the transaction');
    await pg.exec('reset role');
  } finally { await pg.close(); }
});

test('0009: idempotency keys gain a nullable request hash; rows from before it still fit', async () => {
  const pg = await pglite();
  try {
    await upTo(pg, '0008_policies_in_schema.sql');
    await pg.query(`insert into idempotency_keys (scope, reply, firm_id) values ('old', '{"id":"x","version":1}', 'f1a00000-0000-4000-8000-000000000001')`);
    const applied = await migrate(adapt(pg), { dir: DIR });
    assert.ok(applied.includes('0009_idempotency_request.sql'), applied.join());
    await pg.query(`insert into idempotency_keys (scope, reply, firm_id, request_hash) values ('new', '{"id":"y","version":1}', 'f1a00000-0000-4000-8000-000000000001', 'abc')`);
    assert.deepEqual((await pg.query('select scope, request_hash from idempotency_keys order by scope')).rows, [{ scope: 'new', request_hash: 'abc' }, { scope: 'old', request_hash: null }]);
  } finally { await pg.close(); }
});

const AUTH_TABLES = ['sessions', 'recovery_codes', 'one_time_tokens', 'access_requests', 'auth_events'];
const USER_COLUMNS = ['password_hash', 'password_set_at', 'totp_secret', 'totp_pending', 'totp_confirmed_at', 'totp_last_step', 'failed_attempts', 'not_before', 'last_sign_in_at', 'reenrol'];
test('0010: sign-in columns and tables; the app role reaches accounts and sessions only with app.auth set for the transaction; auth events are frozen', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await upTo(pg, '0009_idempotency_request.sql');
    await pg.query(`insert into users (email, name) values ('sam@example.com', 'Sam')`);
    const applied = await migrate(db, { dir: DIR });
    assert.ok(applied.includes('0010_auth.sql'), applied.join());
    const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'users'`)).map(r => r.column_name);
    for (const c of USER_COLUMNS) assert.ok(cols.includes(c), 'users.' + c);
    assert.deepEqual((await db.query(`select password_hash, failed_attempts, totp_last_step, reenrol from users`))[0], { password_hash: null, failed_attempts: 0, totp_last_step: 0, reenrol: false }, 'an existing account keeps safe defaults: it cannot sign in until a password is set');
    for (const t of AUTH_TABLES) assert.deepEqual((await db.query(`select relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = $1`, [t]))[0], { on: true, forced: true }, t);
    const [u] = await db.query('select id from users');

    await pg.exec('set role hwp_app');
    for (const t of ['users', 'memberships', ...AUTH_TABLES]) assert.equal((await db.query(`select count(*)::int n from ${t}`))[0].n, 0, `${t}: nothing without app.auth`);
    await assert.rejects(pg.query(`insert into auth_events (event) values ('x')`), /row-level security/, 'no insert without app.auth');
    const r = await pg.exec(`begin; select set_config('app.auth', 'on', true); select count(*)::int as n from users;
      insert into sessions (id_hash, user_id, stage, expires_at) values ('h1', '${u.id}', 'password', now() + interval '1 hour');
      update users set failed_attempts = 1, not_before = now() where id = '${u.id}';
      insert into auth_events (user_id, event, outcome) values ('${u.id}', 'sign_in', 'ok');
      select count(*)::int as n from sessions; commit`);
    assert.equal(r[2].rows[0].n, 1, 'with app.auth set, the accounts are visible');
    assert.equal(r[6].rows[0].n, 1, 'and the session it wrote');
    assert.equal((await db.query(`select count(*)::int n from sessions`))[0].n, 0, 'the setting ended with the transaction');
    await assert.rejects(pg.query(`update users set email = 'other@example.com'`), /permission denied/, 'the app role may change sign-in columns only, never the email');
    await assert.rejects(pg.query(`insert into users (email) values ('new@example.com')`), /row-level security|permission denied/, 'no account is made outside sign-in (0011 allows it within)');
    await pg.exec('reset role');

    await assert.rejects(pg.query(`update auth_events set outcome = 'changed'`), /not allowed/, 'auth events are never rewritten');
    await assert.rejects(pg.query(`delete from auth_events`), /not allowed/, 'nor deleted');
    assert.equal((await db.query(`select count(*)::int n from auth_events`))[0].n, 1, 'the owner reads them');
    assert.equal((await db.query(`select count(*)::int n from sessions`))[0].n, 1, 'and the sessions');
  } finally { await pg.close(); }
});

test('0011: within sign-in the app role can make an account with a membership and decide an access request; still never change an email or delete', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await upTo(pg, '0010_auth.sql');
    const applied = await migrate(db, { dir: DIR });
    assert.ok(applied.includes('0011_auth_invites.sql'), applied.join());
    await pg.exec('set role hwp_app');
    await assert.rejects(pg.query(`insert into users (email, name) values ('new@example.com', 'New')`), /row-level security/, 'nothing outside sign-in');
    const r = await pg.exec(`begin; select set_config('app.auth', 'on', true);
      insert into users (email, name) values ('new@example.com', 'New');
      insert into memberships (user_id, firm_id, role) select id, '${DEFAULT_FIRM}', 'adviser' from users where email = 'new@example.com';
      insert into access_requests (name, email) values ('Someone', 'someone@example.com');
      update access_requests set status = 'approved', decided_by = 'operator', decided_at = now();
      select count(*)::int as n from memberships; commit`);
    assert.equal(r[6].rows[0].n, 1);
    await assert.rejects(pg.query(`update users set email = 'x@example.com'`), /permission denied/);
    await assert.rejects(pg.query(`update users set active = false`), /permission denied/, 'deactivation is not the app role\'s (Phase 3)');
    await assert.rejects(pg.query(`update users set name = 'x'`), /permission denied/);
    // Phase 3 (0014): a membership's role and active flag are the app role's to change, but only for the firm the transaction works in.
    // Which account and which firm a membership belongs to never are.
    assert.equal((await pg.query(`update memberships set role = 'admin'`)).affectedRows, 0, 'outside sign-in no membership is visible, so none changes');
    const noFirm = await pg.exec(`begin; select set_config('app.auth', 'on', true); update memberships set role = 'admin'; rollback`);
    assert.equal(noFirm[2].affectedRows, 0, 'inside sign-in but with no firm set: nothing changes (fails closed)');
    const withFirm = await pg.exec(`begin; select set_config('app.auth', 'on', true); select set_config('app.firm_id', '${DEFAULT_FIRM}', true); update memberships set role = 'admin', active = false; rollback`);
    assert.equal(withFirm[3].affectedRows, 1, "with the firm set: that firm's membership changes");
    const otherFirm = await pg.exec(`begin; select set_config('app.auth', 'on', true); select set_config('app.firm_id', '${crypto.randomUUID()}', true); update memberships set role = 'admin'; rollback`);
    assert.equal(otherFirm[3].affectedRows, 0, 'working for another firm: nothing of this firm changes');
    await assert.rejects(pg.query(`update memberships set firm_id = firm_id`), /permission denied/, "which firm is never the app role's");
    await assert.rejects(pg.query(`update memberships set user_id = user_id`), /permission denied/, "which account is never the app role's");
    for (const t of ['users', 'memberships', 'access_requests', 'sessions', 'recovery_codes', 'one_time_tokens']) await assert.rejects(pg.query(`delete from ${t}`), /permission denied/, 'delete ' + t);
    await pg.exec('reset role');
    assert.equal((await db.query(`select status from access_requests`))[0].status, 'approved');
  } finally { await pg.close(); }
});

test('0014: several roles and pending invitations: every existing membership is accepted, new ones default to accepted, and the roles are constrained', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await upTo(pg, '0011_auth_invites.sql');
    const u = (await pg.query(`insert into users (email, name) values ('old@example.com', 'Old') returning id`)).rows[0].id;
    await pg.query(`insert into memberships (user_id, firm_id, role, created_at) values ($1, '${DEFAULT_FIRM}', 'admin', '2026-01-02T03:04:05Z')`, [u]);
    const applied = await migrate(db, { dir: DIR });
    assert.ok(applied.includes('0014_member_management.sql'), applied.join());
    const m = (await db.query(`select role, extra_roles, accepted_at, declined_at, created_at from memberships`))[0];
    assert.deepEqual(m.extra_roles, []); assert.equal(m.declined_at, null);
    assert.equal(new Date(m.accepted_at).toISOString(), new Date(m.created_at).toISOString(), 'a membership made before the change counts as accepted when it was made');
    // a membership made without saying (the operator's commands, a new account) is accepted at once; one made pending is not
    const v = (await pg.query(`insert into users (email, name) values ('new@example.com', 'New') returning id`)).rows[0].id;
    await pg.query(`insert into memberships (user_id, firm_id, role) values ($1, '${DEFAULT_FIRM}', 'adviser')`, [v]);
    assert.ok((await db.query(`select accepted_at from memberships where user_id = '${v}'`))[0].accepted_at);
    const w = (await pg.query(`insert into users (email, name) values ('pend@example.com', 'Pend') returning id`)).rows[0].id;
    await pg.query(`insert into memberships (user_id, firm_id, role, accepted_at) values ($1, '${DEFAULT_FIRM}', 'adviser', null)`, [w]);
    assert.equal((await db.query(`select accepted_at from memberships where user_id = '${w}'`))[0].accepted_at, null);
    // the roles are a set of the three, without the primary one repeated
    await pg.query(`update memberships set extra_roles = array['compliance'] where user_id = $1`, [u]);
    for (const bad of [`array['owner']`, `array['admin']`, `array['compliance','compliance','x']`])
      await assert.rejects(pg.query(`update memberships set extra_roles = ${bad} where user_id = $1`, [u]), /memberships_extra_roles_valid/, bad);
    // running it again changes nothing
    assert.deepEqual(await migrate(db, { dir: DIR }), []);
  } finally { await pg.close(); }
});

// A database with every migration up to and including `last` applied, for testing the next one
async function upTo(pg, last) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-upto-'));
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.sql') && f <= last)) fs.copyFileSync(path.join(DIR, f), path.join(dir, f));
  await migrate(adapt(pg), { dir });
  fs.rmSync(dir, { recursive: true, force: true });
}
const household = (pg, id, firm, hmac) => pg.query(`insert into households (id, version, doc, updated_at, firm_id, reference_hmac) values ($1, 1, 'enc:v2:x', now(), $2, $3)`, [id, firm, hmac]);

test('0005: a client reference may exist once per firm; refused loudly while duplicates exist, applied once they are gone', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await upTo(pg, '0004_firms.sql');
    const other = crypto.randomUUID();
    await pg.query(`insert into firms (id, name) values ($1, 'Other')`, [other]);
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID(), d = crypto.randomUUID();
    await household(pg, a, DEFAULT_FIRM, 'h1'); await household(pg, b, DEFAULT_FIRM, 'h1'); // the duplicate
    await household(pg, c, other, 'h1');                                                    // the same reference in another firm is fine
    await household(pg, d, DEFAULT_FIRM, null);                                            // no reference is fine, any number of times
    await household(pg, crypto.randomUUID(), DEFAULT_FIRM, null);
    await assert.rejects(migrate(db, { dir: DIR }), /0005_reference_unique\.sql failed.*1 duplicate client reference/s);
    assert.equal((await db.query(`select count(*)::int n from pg_indexes where indexname = 'households_reference_unique'`))[0].n, 0, 'nothing applied');
    await pg.query(`update households set reference_hmac = 'h2' where id = $1`, [b]); // the operator resolves it
    assert.ok((await migrate(db, { dir: DIR })).includes('0005_reference_unique.sql'));
    await assert.rejects(household(pg, crypto.randomUUID(), DEFAULT_FIRM, 'h1'), /households_reference_unique/, 'the database itself now refuses a duplicate');
    await household(pg, crypto.randomUUID(), other, 'h2');
  } finally { await pg.close(); }
});

test('0006: firm_id becomes required; refused loudly while any row has none', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await upTo(pg, '0005_reference_unique.sql');
    await pg.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'enc:v1:old', now())`, [ID]);
    await assert.rejects(migrate(db, { dir: DIR }), /0006_firm_id_required\.sql failed.*households: 1 row\(s\) without a firm/s);
    assert.equal((await db.query(`select is_nullable from information_schema.columns where table_name = 'households' and column_name = 'firm_id'`))[0].is_nullable, 'YES', 'nothing applied');
    await pg.query(`update households set firm_id = $1 where firm_id is null`, [DEFAULT_FIRM]);
    assert.ok((await migrate(db, { dir: DIR })).includes('0006_firm_id_required.sql'));
    for (const t of ['households', 'household_versions', 'audit_log', 'firm_audit', 'idempotency_keys'])
      assert.equal((await db.query(`select is_nullable from information_schema.columns where table_name = $1 and column_name = 'firm_id'`, [t]))[0].is_nullable, 'NO', t);
    await assert.rejects(pg.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'x', now())`, [crypto.randomUUID()]), /not-null/);
  } finally { await pg.close(); }
});

test('after the whole chain: the app role reads its firm only, the owner reads every firm, and no one inserts a row with no firm', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await migrate(db, { dir: DIR });
    // As deployed: the tables belong to hwp_owner (here they were made by the superuser, so hand them over)
    await pg.exec(fs.readFileSync(path.join(DIR, '..', 'handover-owner.sql'), 'utf8'));
    const other = crypto.randomUUID();
    await pg.query(`insert into firms (id, name) values ($1, 'Other')`, [other]);
    await household(pg, crypto.randomUUID(), DEFAULT_FIRM, 'a1'); await household(pg, crypto.randomUUID(), DEFAULT_FIRM, 'a2'); await household(pg, crypto.randomUUID(), other, 'b1');
    await pg.exec('set role hwp_app');
    const app = await pg.exec(`begin; select set_config('app.firm_id', '${DEFAULT_FIRM}', true); select count(*)::int as n from households; select count(*)::int as n from households where firm_id = '${other}'; commit`);
    assert.equal(app[2].rows[0].n, 2, "the app role, with its firm set, sees that firm's rows");
    assert.equal(app[3].rows[0].n, 0, "and none of another firm's");
    await assert.rejects(pg.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'x', now())`, [crypto.randomUUID()]), /not-null|row-level security/, 'app: no firm, no insert');
    await pg.exec('reset role; set role hwp_owner');
    assert.equal((await db.query(`select count(*)::int n from households`))[0].n, 3, 'the owner reads every firm (0007)');
    await assert.rejects(pg.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'x', now())`, [crypto.randomUUID()]), /not-null|row-level security/, 'owner: no firm, no insert');
    await assert.rejects(pg.query(`insert into households (id, version, doc, updated_at, firm_id) values ($1, 1, 'x', now(), $2)`, [crypto.randomUUID(), DEFAULT_FIRM]), /row-level security/, 'owner: no insert policy at all');
    await pg.exec('reset role');
    assert.equal((await db.query(`select count(*)::int n from households`))[0].n, 3);
  } finally { await pg.close(); }
});

test('firm settings: one row, and versions and audit entries can never be changed or deleted', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await migrate(db, { dir: DIR });
    await pg.query(`insert into firm_settings (version, doc, updated_at) values (1, 'enc:v1:firm', now())`);
    await pg.query(`insert into firm_versions (version, doc) values (1, 'enc:v1:one')`);
    await pg.query(`insert into firm_audit (entry, firm_id) values ('enc:v1:a', $1)`, [DEFAULT_FIRM]);
    await assert.rejects(pg.query(`insert into firm_settings (id, version, doc, updated_at) values (false, 1, 'x', now())`), /check/i, 'only the one firm row');
    await assert.rejects(pg.query(`insert into firm_settings (version, doc, updated_at) values (2, 'x', now())`), /duplicate key/i);
    await pg.query(`update firm_settings set version = 2, doc = 'enc:v1:two'`); // the current row moves on with each save
    for (const sql of ['delete from firm_settings', 'truncate firm_settings', 'update firm_versions set doc = $$x$$', 'delete from firm_versions', 'truncate firm_versions', 'update firm_audit set entry = $$x$$', 'delete from firm_audit', 'truncate firm_audit'])
      await assert.rejects(pg.query(sql), /not allowed: records are kept/, sql);
  } finally { await pg.close(); }
});

test('a failed migration leaves nothing behind and is retried next time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-mig-'));
  const pg = await pglite(), db = adapt(pg);
  try {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table a (x int);');
    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'create table b (x int); select no_such_function();');
    await assert.rejects(migrate(db, { dir }), /0002_b\.sql failed, nothing from it was applied/);
    assert.equal((await db.query(`select to_regclass('b') is null as gone`))[0].gone, true);
    assert.deepEqual((await db.query(`select name from schema_migrations`)).map(r => r.name), ['0001_a.sql']);
    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'create table b (x int);');
    assert.deepEqual(await migrate(db, { dir }), ['0002_b.sql']);
  } finally { await pg.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('editing an applied migration is refused; line endings do not count as an edit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-mig-'));
  const pg = await pglite(), db = adapt(pg);
  try {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table a (x int);\n');
    await migrate(db, { dir });
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table a (x int);\r\n');
    assert.deepEqual(await migrate(db, { dir }), []);
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table a (x int, y int);\n');
    await assert.rejects(migrate(db, { dir }), /0001_a\.sql was changed after it was applied/);
  } finally { await pg.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PostgreSQL older than 14 is refused before anything runs', async () => {
  const ran = [];
  const db = { query: async sql => { ran.push(sql); return [{ n: 130012 }]; }, exec: async sql => { ran.push(sql); } };
  await assert.rejects(migrate(db, { dir: DIR }), /PostgreSQL 14 or later is needed \(this server is 13\)/);
  assert.equal(ran.length, 1);
});
