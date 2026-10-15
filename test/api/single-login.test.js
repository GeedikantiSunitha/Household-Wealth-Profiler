// Single-login mode (DB_LOGIN_MODE=single, db/single-login.js): the set-up for hosts that give one
// database login and no way to create roles (DCDeploy). A fresh database is owned by a login that is not
// a superuser, cannot create roles and cannot bypass row-level security, as a host's would be. On it:
// migrations run as a separate command (no role is created), the posture check passes, the real server
// answers the same API and records contracts as everywhere else, firms stay apart, kept rows cannot be
// deleted outside an approved purge, and the operator's commands work through operator mode only.
// Skipped unless TEST_DATABASE_URL is set (a superuser on a scratch cluster, to make the login).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { translate, assertTranslated } = require('../../db/single-login.js');
const { apiContract } = require('./api-contract.js');
const { recordsContract } = require('./records-contract.js');
const { waitForServer } = require('./servers.js');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'db', 'migrations');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');

test('every migration translates to single-login SQL that names no role and creates none', () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const s = translate(read(f));
    assertTranslated(f, s);
    assert.equal(translate(s), s, `${f}: translating twice changes nothing`);
  }
  const all = files.map(f => translate(read(f))).join('\n');
  assert.equal((all.match(/to public using \(hwp_operator_mode\(\) and \(true\)\)/g) || []).length, 3, 'owner_rows: operator mode only (0004, 0008, 0010)');
  assert.ok(/owner_reads on %I for select to public using \(hwp_maintenance_mode\(\) and \(true\)\)/.test(all), 'owner_reads: maintenance mode only');
  assert.ok(/update_own_firm on memberships as restrictive for update to public\n\s*using \(hwp_operator_mode\(\) or \(/.test(all), 'the restrictive policy does not bind operator mode');
  assert.ok(/if new.status = 'purged' and exists \(select 1 from households h where h.id = new.household_id\)/.test(all), 'a request is marked purged only once its household is gone');
});

test('a migration with a role reference no rule covers is refused before anything is applied', () => {
  assert.throws(() => assertTranslated('9999_x.sql', translate('create policy p on t to hwp_operator using (true);')), /no rule for this role reference/);
  assert.throws(() => assertTranslated('9999_x.sql', translate('alter table t owner to hwp_owner;')), /9999_x.sql/);
  assert.doesNotThrow(() => assertTranslated('9999_x.sql', translate('-- hwp_app is mentioned in a comment only\ncreate table t (id int);')));
});

test('DB_LOGIN_MODE=single: one login; the owner and operator connections are DATABASE_URL with the modes on', () => {
  const { load } = require('../../apps/api/src/config');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hwp-cfg-'));
  try {
    const base = { DATA_KEY: crypto.randomBytes(32).toString('base64'), DATABASE_URL: 'postgres://u:p@db.internal:5432/hwp' };
    const c = load({ env: { ...base, DB_LOGIN_MODE: 'single' }, root });
    assert.equal(c.singleLogin, true);
    assert.equal(new URL(c.databaseOwnerUrl).searchParams.get('options'), '-c app.operator=on -c app.maintenance=on');
    assert.equal(new URL(c.databaseOperatorUrl).searchParams.get('options'), '-c app.operator=on');
    assert.equal(new URL(c.databaseOwnerUrl).host, 'db.internal:5432');
    assert.throws(() => load({ env: { ...base, DB_LOGIN_MODE: 'single', DATABASE_OWNER_URL: base.DATABASE_URL }, root }), /leave DATABASE_OWNER_URL and DATABASE_OPERATOR_URL unset/);
    assert.throws(() => load({ env: { ...base, DB_LOGIN_MODE: 'double' }, root }), /DB_LOGIN_MODE must be/);
    assert.equal(load({ env: base, root }).singleLogin, false, 'separate roles stay the default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.describe('single-login mode on PostgreSQL', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const tag = crypto.randomBytes(4).toString('hex');
  const LOGIN = `hwp_single_${tag}`, DB = `hwp_single_${tag}_test`, PW = crypto.randomBytes(12).toString('hex');
  const loginUrl = (modes = []) => { const u = new URL(BASE_URL); u.username = LOGIN; u.password = PW; u.pathname = '/' + DB; if (modes.length) u.searchParams.set('options', modes.map(m => `-c app.${m}=on`).join(' ')); return u.toString(); };
  const PORT = 20000 + Math.floor(Math.random() * 1000), BASE = `http://127.0.0.1:${PORT}`;
  const node = (args, env = {}) => spawnSync(process.execPath, ['server.js', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...ENV, ...env }, input: env.INPUT });
  const auth = (n, p) => ({ Authorization: 'Basic ' + Buffer.from(`${n}:${p}`).toString('base64') });
  let admin, proc, ENV;
  const as = async (modes, fn) => { const c = new Client({ connectionString: loginUrl(modes) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await admin.query(`create role ${LOGIN} login password '${PW}' nosuperuser nocreaterole nobypassrls nocreatedb`);
    await admin.query(`create database ${DB} owner ${LOGIN}`);
    const d = new Client({ connectionString: (() => { const u = new URL(BASE_URL); u.pathname = '/' + DB; return u.toString(); })() }); await d.connect();
    await d.query(`revoke create on schema public from public; alter schema public owner to ${LOGIN}`); await d.end();
    const hash = (n, p) => execFileSync(process.execPath, ['server.js', 'hash-password', n, p], { cwd: ROOT }).toString().trim();
    ENV = { ...process.env, NODE_ENV: '', PORT: String(PORT), HOST: '127.0.0.1', DB_LOGIN_MODE: 'single', DATABASE_URL: loginUrl(), DATABASE_OWNER_URL: '', DATABASE_OPERATOR_URL: '',
      DATA_KEY: crypto.randomBytes(32).toString('base64'), ALPHAVANTAGE_KEY: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', PUBLIC_URL: '',
      AUTH_USERS: [hash('sam', 'correct horse'), hash('chris', 'battery staple')].join(';') };
  }, { timeout: 120000 });
  test.after(async () => {
    if (proc) proc.kill();
    if (admin) {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [DB]).catch(() => {});
      await admin.query(`drop database if exists ${DB}`); await admin.query(`drop role if exists ${LOGIN}`); await admin.end();
    }
  });

  test('migrate runs as a separate command and creates no role; check-db-posture then passes', async () => {
    const roles = (await admin.query("select count(*)::int n from pg_roles")).rows[0].n;
    const m = node(['migrate']);
    assert.equal(m.status, 0, m.stderr);
    assert.match(m.stdout, /Applied \d+ migration\(s\)/);
    assert.equal((await admin.query("select count(*)::int n from pg_roles")).rows[0].n, roles, 'no role was created');
    assert.equal(node(['migrate']).stdout.trim(), 'No migrations pending.');
    const p = node(['check-db-posture']);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /PASS {2}single/);
  });

  test('the server refuses to start when DATABASE_URL switches on operator mode (commands may, the server never)', async () => {
    const bad = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...ENV, PORT: String(PORT + 1), DATABASE_URL: loginUrl(['operator']) } });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /switches on operator or maintenance mode for the server/);
  });

  test.describe('the server in single-login mode', () => {
    test.before(async () => {
      proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: ENV, stdio: 'pipe' });
      await waitForServer(proc, BASE);
    }, { timeout: 120000 });
    apiContract(() => ({ base: BASE, sam: auth('sam', 'correct horse'), chris: auth('chris', 'battery staple') }));
    recordsContract(() => ({ base: BASE, sam: auth('sam', 'correct horse'), chris: auth('chris', 'battery staple') }));
  });

  test('in the database: no firm, no rows; firms apart; kept rows are not deleted; a request is not marked purged by hand', async () => {
    await as([], async c => {
      for (const t of ['households', 'household_versions', 'audit_log', 'users', 'memberships', 'sessions', 'access_log', 'firms']) assert.equal((await c.query(`select count(*)::int n from ${t}`)).rows[0].n, 0, t);
      const firm = 'f1a00000-0000-4000-8000-000000000001'; // the default firm, where the contracts above saved their households
      await c.query('begin'); await c.query("select set_config('app.firm_id', $1, true)", [firm]);
      const n = (await c.query('select count(*)::int n from households')).rows[0].n;
      assert.ok(n > 0, 'the default firm sees its own households');
      const id = (await c.query('select id from households limit 1')).rows[0].id;
      await c.query('savepoint s');
      await assert.rejects(c.query('delete from households where id = $1', [id]), /not allowed: records are kept/);
      await c.query('rollback to savepoint s');
      await assert.rejects(c.query('truncate audit_log'), /not allowed/);
      await c.query('rollback');
      await c.query('begin'); await c.query("select set_config('app.firm_id', $1, true)", [crypto.randomUUID()]);
      assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, 0, 'another firm sees none of them');
      await c.query('rollback');
      await c.query('begin'); await c.query("select set_config('app.firm_id', $1, true)", [firm]);
      const hh = (await c.query('select id from households limit 1')).rows[0].id;
      const req = (await c.query(`insert into purge_requests (firm_id, household_id, retention_until, requested_by) values ($1, $2, '2020-01-01', 'ann') returning id`, [firm, hh])).rows[0].id;
      await assert.rejects(c.query(`update purge_requests set status = 'purged' where id = $1`, [req]), /only by purge_household/);
      await c.query('rollback');
    });
  });

  test('operator mode reads accounts and firms but no client row; maintenance mode reads the encrypted rows', async () => {
    await as(['operator'], async c => {
      assert.ok((await c.query('select count(*)::int n from firms')).rows[0].n >= 1);
      assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, 0, 'no client rows in operator mode');
    });
    await as(['maintenance'], async c => {
      const r = (await c.query('select doc from households limit 1')).rows[0];
      assert.match(r.doc, /^enc:v2:/, 'ciphertext only: no key in the database');
      assert.equal((await c.query('select count(*)::int n from users')).rows[0].n, 0, 'no accounts in maintenance mode alone');
    });
  });

  test('the operator commands work with the one login: firm-create, create-user, set-password, firm-seats, access-review', async () => {
    const f = node(['firm-create', 'Alder Wealth', '3']);
    assert.equal(f.status, 0, f.stderr);
    const firmId = /([0-9a-f-]{36})/.exec(f.stdout)[1];
    let r = node(['create-user', 'jo@alder.example', 'Jo Alder', firmId, 'admin']);
    assert.equal(r.status, 0, r.stderr);
    r = node(['set-password', 'jo@alder.example'], { INPUT: 'a long enough passphrase 1\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(node(['firm-seats', firmId, '4']).status, 0);
    r = node(['access-review', firmId]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /jo@alder.example/);
    assert.equal(node(['grant-operator']).status, 1, 'no operator role to grant with one login');
  });

  test('check-db-posture fails a deploy for a table without forced RLS and for a missing retention trigger', async () => {
    const d = new Client({ connectionString: (() => { const u = new URL(BASE_URL); u.pathname = '/' + DB; return u.toString(); })() }); await d.connect();
    try {
      await d.query('create table public.posture_probe (id int)');
      let p = node(['check-db-posture']);
      assert.equal(p.status, 2); assert.match(p.stdout, /FAIL {2}rls .*posture_probe/);
      await d.query('drop table public.posture_probe');
      await d.query('drop trigger access_log_no_truncate on public.access_log');
      p = node(['check-db-posture']);
      assert.equal(p.status, 2); assert.match(p.stdout, /FAIL {2}retention .*access_log/);
      await d.query('create trigger access_log_no_truncate before truncate on public.access_log execute function public.refuse_change()');
      assert.equal(node(['check-db-posture']).status, 0, 'safe again once repaired');
    } finally { await d.end(); }
  });

  test('without single-login mode, the migrations cannot run on a host that cannot create roles', async (t) => {
    if ((await admin.query("select count(*)::int n from pg_roles where rolname in ('hwp_owner', 'hwp_app')")).rows[0].n) { t.skip('this cluster already has the hwp roles (other test files made them), so the refusal cannot be shown here'); return; }
    const db2 = DB.replace(/_test$/, '_sep_test');
    await admin.query(`create database ${db2} owner ${LOGIN}`);
    try {
      const u = new URL(loginUrl()); u.pathname = '/' + db2;
      const r = node(['migrate'], { DB_LOGIN_MODE: 'separate', DATABASE_URL: u.toString() });
      assert.equal(r.status, 1); assert.match(r.stderr, /0004_firms.sql failed.*permission denied to create role/);
    } finally { await admin.query(`drop database if exists ${db2}`); }
  });

  test('the owner commands work with the one login: check-records, subject-access-user, rotate-key', async () => {
    let r = node(['check-records']);
    assert.ok([0, 2].includes(r.status), r.stderr); assert.doesNotMatch(r.stderr, /permission|row-level/i);
    const out = path.join(require('node:os').tmpdir(), `sar-${tag}.json`);
    r = node(['subject-access-user', 'jo@alder.example', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).account.email, 'jo@alder.example'); fs.rmSync(out, { force: true });
    r = node(['rotate-key'], { NEW_DATA_KEY: crypto.randomBytes(32).toString('base64') });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\d+ firm key\(s\) re-wrapped/);
  });
});
