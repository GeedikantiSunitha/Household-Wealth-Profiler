// db/migrate.js and the self-hosted migrations (db/migrations), in PGlite (Postgres in WebAssembly)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('../../db/migrate.js');

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const pglite = async () => { const { PGlite } = await import('@electric-sql/pglite'); return new PGlite(); };
const adapt = pg => ({ query: async (sql, params) => (await pg.query(sql, params)).rows, exec: sql => pg.exec(sql) });
const ID = '11111111-1111-4111-8111-111111111111';

test('a new database gets every migration once', async () => {
  const pg = await pglite(), db = adapt(pg);
  try {
    assert.deepEqual(await migrate(db, { dir: DIR }), fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort());
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
