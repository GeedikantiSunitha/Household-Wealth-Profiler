// node server.js migrate-status, end to end on PostgreSQL: every migration as applied or pending, exit 0
// only when all are applied, and it never writes. Runs when TEST_DATABASE_URL points at a scratch
// database, in a schema of its own. Without a database setting it says so and exits 1.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('../api/test-db.js').testDatabaseUrl();
const FILES = fs.readdirSync(path.join(ROOT, 'db', 'migrations')).filter(f => f.endsWith('.sql')).sort();
const blank = { DATABASE_URL: '', DATABASE_OWNER_URL: '', DATABASE_OPERATOR_URL: '', DB_LOGIN_MODE: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', PUBLIC_URL: '', AUTH_USERS: '', DATA_KEY: '', ALLOW_PLAINTEXT: '', NODE_ENV: '' };
const run = (args, env) => spawnSync(process.execPath, ['server.js', ...args], { cwd: ROOT, env: { ...process.env, ...blank, ...env }, encoding: 'utf8' });

test('without a database setting: a clear message, exit 1, nothing needs a key or a mail address', () => {
  const r = run(['migrate-status'], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Set DATABASE_OWNER_URL \(or DATABASE_URL\) to the database to look at/);
});

test.describe('migrate-status on PostgreSQL', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_mstatus_' + crypto.randomBytes(4).toString('hex');
  const PW = require('../api/test-db.js').TEST_ROLE_PASSWORD;
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  let admin, env;

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('../api/test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    env = { DATABASE_URL: urlFor('hwp_owner'), DATA_KEY: crypto.randomBytes(32).toString('base64') };
  });
  test.after(async () => { await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

  test('an empty database: every file PENDING, exit 2, and nothing created; after migrate, every file applied and exit 0', async () => {
    let r = run(['migrate-status'], env);
    assert.equal(r.status, 2, r.stderr);
    for (const f of FILES) assert.match(r.stdout, new RegExp(`PENDING +${f}`));
    assert.match(r.stdout, new RegExp(`0 applied, ${FILES.length} pending`));
    assert.equal((await admin.query(`select to_regclass('${schema}.schema_migrations') is not null as made`)).rows[0].made, false, 'asking for the status created nothing');

    r = run(['migrate'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Applied ${FILES.length} migration`));

    r = run(['migrate-status'], env);
    assert.equal(r.status, 0, r.stderr);
    for (const f of FILES) assert.match(r.stdout, new RegExp(`applied +${f} +\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC`));
    assert.match(r.stdout, new RegExp(`${FILES.length} applied, 0 pending\\.`));
    assert.doesNotMatch(r.stdout, /PENDING|CHANGED|UNKNOWN/);
  });

  test('a migration applied here with no file, or a recorded checksum that no longer matches, is reported and exits 2; the table is untouched', async () => {
    const before = (await admin.query(`select name, checksum from ${schema}.schema_migrations order by name`)).rows;
    await admin.query(`update ${schema}.schema_migrations set checksum = 'edited' where name = $1`, [FILES[0]]);
    await admin.query(`insert into ${schema}.schema_migrations (name, checksum) values ('0999_newer.sql', 'x')`);
    const r = run(['migrate-status'], env);
    assert.equal(r.status, 2);
    assert.match(r.stdout, new RegExp(`CHANGED +${FILES[0]}`));
    assert.match(r.stdout, /UNKNOWN +0999_newer\.sql/);
    assert.match(r.stdout, /1 changed after being applied/);
    const after = (await admin.query(`select name, checksum from ${schema}.schema_migrations order by name`)).rows;
    assert.equal(after.length, before.length + 1, 'only what this test inserted: the command wrote nothing');
    assert.equal(after.find(x => x.name === FILES[0]).checksum, 'edited');
  });
});
