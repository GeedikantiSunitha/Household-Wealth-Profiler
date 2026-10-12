// db/migrate.js and the self-hosted migrations (db/migrations), in PGlite (Postgres in WebAssembly)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrate, pending } = require('../../db/migrate.js');

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
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

test('firm settings: one row, and versions and audit entries can never be changed or deleted', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    await migrate(db, { dir: DIR });
    await pg.query(`insert into firm_settings (version, doc, updated_at) values (1, 'enc:v1:firm', now())`);
    await pg.query(`insert into firm_versions (version, doc) values (1, 'enc:v1:one')`);
    await pg.query(`insert into firm_audit (entry) values ('enc:v1:a')`);
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
