// node server.js subject-access-user (Phase 4): what the app keeps about a sign-in account, as the
// owner, across firms; never a secret (password hash, authenticator secret, token or code hashes);
// the export is itself recorded. PostgreSQL only; skipped unless TEST_DATABASE_URL is set.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate, pgClient } = require('../../db/migrate.js');
const { subjectAccessUser } = require('../../backend/src/cli/subject-access-user.js');

const BASE_URL = require('../api/test-db.js').testDatabaseUrl();
const ROOT = path.join(__dirname, '..', '..');
const A = 'f1a00000-0000-4000-8000-000000000001';

test.describe('account subject access export', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_asar_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-asar-'));
  let admin, owner, uid;
  const SECRETS = ['scrypt$secret-hash', 'enc:v1:totp-secret-sealed', 'token-hash-0123', 'code-hash-4567'];

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('../api/test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    owner = new Client({ connectionString: urlFor('hwp_owner') }); await owner.connect();
    await migrate(pgClient(owner), { dir: path.join(ROOT, 'db', 'migrations') });
    uid = (await owner.query(`insert into users (email, name, password_hash, password_set_at, totp_secret, totp_confirmed_at) values ('dana@example.com', 'Dana', $1, now(), $2, now()) returning id`, SECRETS.slice(0, 2))).rows[0].id;
    await owner.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'compliance')`, [uid, A]);
    await owner.query(`insert into sessions (id_hash, user_id, firm_id, stage, expires_at, ip) values ('session-hash', $1, $2, 'full', now() + interval '1 hour', '203.0.113.5')`, [uid, A]);
    await owner.query(`insert into one_time_tokens (user_id, purpose, token_hash, expires_at) values ($1, 'reset', $2, now())`, [uid, SECRETS[2]]);
    await owner.query(`insert into recovery_codes (user_id, code_hash) values ($1, $2)`, [uid, SECRETS[3]]);
    await owner.query(`insert into auth_events (user_id, email, event, outcome) values ($1, 'dana@example.com', 'sign_in', 'ok'), (null, 'dana@example.com', 'sign_in', 'unknown')`, [uid]);
    await owner.query(`insert into access_requests (name, email) values ('Dana', 'dana@example.com')`);
    const app = new Client({ connectionString: urlFor('hwp_app') }); await app.connect();
    await app.query('begin'); await app.query("select set_config('app.firm_id', $1, true)", [A]);
    await app.query(`insert into access_log (firm_id, actor, user_id, action, household_id) values ($1, 'dana@example.com', $2, 'read', gen_random_uuid())`, [A, uid]);
    await app.query(`insert into purge_requests (firm_id, household_id, retention_until, requested_by, requested_by_id) values ($1, gen_random_uuid(), '2020-01-01', 'dana@example.com', $2)`, [A, uid]);
    await app.query('commit'); await app.end();
  }, { timeout: 120000 });
  test.after(async () => {
    if (owner) await owner.end();
    if (admin) { await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('everything about the account, from every table, with no secret in it; the export is recorded; an existing file is never overwritten', async () => {
    const out = path.join(dir, 'dana.json');
    assert.equal(await subjectAccessUser({ ownerUrl: urlFor('hwp_owner'), args: ['Dana@Example.com', out], log: () => {} }), 0);
    const text = fs.readFileSync(out, 'utf8');
    for (const s of [...SECRETS, 'session-hash']) assert.ok(!text.includes(s), `no secret in the export: ${s}`);
    const p = JSON.parse(text);
    assert.equal(p.kind, 'account-subject-access-export');
    assert.equal(p.account.email, 'dana@example.com'); assert.equal(p.account.has_password, true); assert.equal(p.account.has_authenticator, true);
    assert.ok(!('password_hash' in p.account) && !('totp_secret' in p.account));
    assert.deepEqual(p.memberships.map(m => [m.firm, m.role]), [['Default firm', 'compliance']]);
    assert.equal(p.sessions.length, 1); assert.equal(p.sessions[0].ip, '203.0.113.5');
    assert.deepEqual([p.recoveryCodes.length, p.oneTimeLinks.length, p.accessRequests.length, p.accessLog.length], [1, 1, 1, 1]);
    assert.deepEqual(p.signInEvents.map(e => e.outcome), ['ok', 'unknown'], 'including attempts on the address before the account matched');
    assert.deepEqual(p.purgeRequests.map(r => r.part), ['requested']);
    assert.equal((await owner.query(`select count(*)::int n from auth_events where user_id = $1 and event = 'subject_access'`, [uid])).rows[0].n, 1);
    assert.equal(await subjectAccessUser({ ownerUrl: urlFor('hwp_owner'), args: ['dana@example.com', out], log: () => {} }), 1, 'the file exists: refused');
    assert.equal(await subjectAccessUser({ ownerUrl: urlFor('hwp_owner'), args: ['nobody@example.com', path.join(dir, 'x.json')], log: () => {} }), 1);
  });
});
