// node server.js backup and restore-drill (Phase 4), end to end on a scratch cluster: a backup of a
// database with encrypted client records, a drill that restores it and proves counts, migrations,
// triggers, records and isolation; and every way it must refuse: a damaged or replaced file, an
// altered manifest, another BACKUP_KEY, a role that row security would hide rows from, the wrong
// DATA_KEY (a check fails), BACKUP_KEY equal to DATA_KEY. Old backups are pruned, never the newest.
// Skipped unless TEST_DATABASE_URL is set and pg_dump / pg_restore (PG_BIN, else the PATH) are at
// least the server's version.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const H = require('../../../packages/core/core.js');
const { createStore, DEFAULT_FIRM_ID } = require('../../../backend/src/repositories');
const { createSealer } = require('../../../backend/src/crypto/seal.js');
const { createHouseholdService } = require('../../../backend/src/services/households.js');
const { prune, listBackups, toolMajor } = require('../../../backend/src/cli/backup.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('../api/test-db.js').testDatabaseUrl();
const gen = () => crypto.randomBytes(32).toString('base64');

test('prune removes backups older than the retention period, never the newest, and only this database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-prune-'));
  try {
    const names = ['hwp-db-20260101T000000Z.backup', 'hwp-db-20260901T000000Z.backup', 'hwp-db-20261010T000000Z.backup', 'hwp-other-20250101T000000Z.backup', 'notes.txt'];
    for (const n of names) { fs.writeFileSync(path.join(dir, n), 'x'); fs.writeFileSync(path.join(dir, n + '.manifest.json'), '{}'); }
    assert.deepEqual((await listBackups(dir, 'db')).map(b => b.name), [names[2], names[1], names[0]]);
    assert.deepEqual(await prune(dir, 'db', 35, new Date('2026-10-13T00:00:00Z')), [names[1], names[0]]);
    assert.deepEqual(fs.readdirSync(dir).sort(), [names[2], names[2] + '.manifest.json', names[3], names[3] + '.manifest.json', 'notes.txt', 'notes.txt.manifest.json'].sort());
    assert.deepEqual(await prune(dir, 'db', 1, new Date('2030-01-01T00:00:00Z')), [], 'the newest is kept however old');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BACKUP_KEY must be its own key: the same as DATA_KEY is refused at start-up', () => {
  const { load } = require('../../../backend/src/config');
  const k = gen(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-cfg-'));
  try {
    assert.throws(() => load({ env: { DATA_KEY: k, BACKUP_KEY: k, DATABASE_URL: 'postgres://x' }, root }), /BACKUP_KEY must not be the same as DATA_KEY/);
    assert.throws(() => load({ env: { DATA_KEY: k, BACKUP_KEY: 'short', DATABASE_URL: 'postgres://x' }, root }), /BACKUP_KEY must be 32 bytes/);
    assert.throws(() => load({ env: { DATA_KEY: k, BACKUP_RETENTION_DAYS: '0', DATABASE_URL: 'postgres://x' }, root }), /BACKUP_RETENTION_DAYS/);
    const c = load({ env: { BACKUP_KEY: gen(), NODE_ENV: 'production' }, root, command: 'backup' });
    assert.equal(c.key, null, 'the backup job needs no DATA_KEY, and production server settings do not apply to it');
    assert.equal(c.backupRetentionDays, 35);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function pgToolsUsable() {
  if (!BASE_URL) return 'set TEST_DATABASE_URL to run';
  try {
    const server = +execFileSync(process.execPath, ['-e', `const {Client}=require('pg');const c=new Client({connectionString:process.argv[1]});c.connect().then(()=>c.query('show server_version_num')).then(r=>{console.log(Math.floor(r.rows[0].server_version_num/10000));return c.end()})`, BASE_URL], { cwd: ROOT }).toString().trim();
    const pgBin = process.env.PG_BIN || '';
    if (toolMajor(pgBin, 'pg_dump') < server || toolMajor(pgBin, 'pg_restore') < server) return `pg_dump/pg_restore older than the server (${server}); set PG_BIN`;
    return false;
  } catch (e) { return 'pg_dump/pg_restore not found (set PG_BIN): ' + e.message.split('\n')[0]; }
}

test.describe('backup and restore drill', { skip: pgToolsUsable() }, () => {
  const { Client } = require('pg');
  const db = 'hwp_bk_' + crypto.randomBytes(4).toString('hex') + '_test';
  const url = (() => { const u = new URL(BASE_URL); u.pathname = '/' + db; return u.toString(); })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-backups-'));
  const DATA_KEY = gen(), BACKUP_KEY = gen();
  let admin;
  const env = extra => ({ ...process.env, DATABASE_URL: '', DATABASE_OWNER_URL: '', AUTH_USERS: '', SMTP_URL: '', OPERATOR_EMAIL: '', DB_LOGIN_MODE: '', PUBLIC_URL: '', NODE_ENV: '',
    DATA_KEY, BACKUP_KEY, BACKUP_DATABASE_URL: url, BACKUP_DIR: dir, PG_BIN: process.env.PG_BIN || '', ...extra });
  const run = (args, extra = {}) => new Promise(ok => execFile(process.execPath, ['server.js', ...args], { cwd: ROOT, env: env(extra), timeout: 240000 }, (e, stdout, stderr) => ok({ code: e ? e.code : 0, out: stdout + stderr })));
  const newest = async () => path.join(dir, (await listBackups(dir))[0].name);

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await admin.query(`create database ${db}`);
    const store = createStore({ databaseUrl: url, databasePoolMax: 2, root: ROOT }, createSealer(Buffer.from(DATA_KEY, 'base64')));
    await store.init();
    const svc = createHouseholdService({ store, HWP: H });
    const ctx = { user: 'sam', firmId: DEFAULT_FIRM_ID };
    for (let i = 0; i < 3; i++) { const st = H.sample(); st.household.reference = 'BK-' + i; const { id } = await svc.create(ctx, st); await svc.get(ctx, id); }
    await store.end();
  }, { timeout: 120000 });
  test.after(async () => {
    if (admin) {
      for (const r of (await admin.query(`select datname from pg_database where datname like $1`, [db.slice(0, 30) + '_restore_drill_%'])).rows) await admin.query(`drop database if exists "${r.datname}"`);
      await admin.query(`drop database if exists ${db}`); await admin.end();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a backup is encrypted (no client data readable in it) with a signed manifest of counts and migrations', async () => {
    const r = await run(['backup']);
    assert.equal(r.code, 0, r.out);
    const file = await newest();
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString(), 'HWPBK001');
    for (const s of ['Harrington', 'BK-0', 'households', 'CREATE TABLE']) assert.ok(!bytes.includes(Buffer.from(s)), `"${s}" is not readable in the file`);
    const m = JSON.parse(fs.readFileSync(file + '.manifest.json', 'utf8'));
    assert.equal(m.counts['public.households'], '3'); assert.equal(m.counts['public.access_log'], '3');
    assert.ok(m.migrations.includes('0013_retention.sql')); assert.match(m.mac, /^[0-9a-f]{64}$/);
    assert.equal(m.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(fs.readdirSync(dir).filter(f => /\.partial$|\.sql$|\.dump$/.test(f)), [], 'nothing unencrypted or partial is left');
  });

  test('the restore drill restores into a scratch database, passes every check, writes a report and drops the scratch database', async () => {
    const r = await run(['restore-drill']);
    assert.equal(r.code, 0, r.out);
    for (const name of ['counts', 'migrations', 'triggers', 'records', 'isolation']) assert.match(r.out, new RegExp(`PASS  ${name}`));
    const report = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.includes('.drill-'))), 'utf8'));
    assert.equal(report.passed, true); assert.equal(report.dropped, true);
    assert.equal(report.checks.find(c => c.name === 'records').opened, 9, '3 households, 3 versions, 3 audit entries');
    assert.deepEqual((({ withoutFirm, firmRows, expected }) => ({ withoutFirm, firmRows, expected }))(report.checks.find(c => c.name === 'isolation')), { withoutFirm: 0, firmRows: 3, expected: 3 });
    assert.equal((await admin.query(`select count(*)::int n from pg_database where datname = $1`, [report.database])).rows[0].n, 0);
  });

  test('with the wrong DATA_KEY the drill fails its records check (exit 2) and still drops the scratch database', async () => {
    const r = await run(['restore-drill'], { DATA_KEY: gen() });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /FAIL {2}records: firm .* does not unwrap with DATA_KEY/);
    assert.match(r.out, /Restore drill FAILED/);
    assert.equal((await admin.query(`select count(*)::int n from pg_database where datname like $1`, [db.slice(0, 30) + '_restore_drill_%'])).rows[0].n, 0);
  });

  test('refused before anything is restored: another BACKUP_KEY, an altered manifest, a damaged file', async () => {
    const file = await newest();
    let r = await run(['restore-drill'], { BACKUP_KEY: gen() });
    assert.equal(r.code, 1); assert.match(r.out, /fails its signature check/);
    const mf = file + '.manifest.json', original = fs.readFileSync(mf, 'utf8');
    try {
      const m = JSON.parse(original); m.counts['public.households'] = '2'; fs.writeFileSync(mf, JSON.stringify(m));
      r = await run(['restore-drill', file]);
      assert.equal(r.code, 1); assert.match(r.out, /fails its signature check/);
    } finally { fs.writeFileSync(mf, original); }
    const bytes = fs.readFileSync(file);
    try {
      const t = Buffer.from(bytes); t[t.length - 5] ^= 1; fs.writeFileSync(file, t);
      r = await run(['restore-drill', file]);
      assert.equal(r.code, 1); assert.match(r.out, /does not match its manifest/);
    } finally { fs.writeFileSync(file, bytes); }
  });

  test('a backup as a role that row security hides rows from is refused, writing nothing', async () => {
    const before = fs.readdirSync(dir).length;
    const PW = crypto.randomBytes(12).toString('hex');
    await require('../api/test-db.js').ensureRoles(admin, PW);
    const u = new URL(url); u.username = 'hwp_app'; u.password = PW;
    const r = await run(['backup'], { BACKUP_DATABASE_URL: u.toString() });
    assert.equal(r.code, 1); assert.match(r.out, /reads every row \(superuser or BYPASSRLS\)/);
    assert.equal(fs.readdirSync(dir).length, before);
  });

  test('--keep leaves the restored copy for use', async () => {
    const r = await run(['restore-drill', '--keep']);
    assert.equal(r.code, 0, r.out);
    const kept = /kept as database (\S+)\./.exec(r.out)[1];
    const c = new Client({ connectionString: (() => { const u = new URL(BASE_URL); u.pathname = '/' + kept; return u.toString(); })() });
    await c.connect();
    try { assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, 3); } finally { await c.end(); }
    await admin.query(`drop database "${kept}"`);
  });
});
