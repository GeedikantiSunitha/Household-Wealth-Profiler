// backend/src/auth/store.js: accounts, sign-in state and auth events on PostgreSQL, behind row
// security that the app role passes only inside the store's own transactions. Runs when
// TEST_DATABASE_URL points at a scratch database, in a schema of its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createAuthStore, normaliseEmail } = require('../../../backend/src/repositories/auth-store.js');
const { createPool } = require('../../../backend/src/db/pool.js');
const { migrate, pgClient } = require('../../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../../backend/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();

test('emails are matched trimmed and in lower case', () => {
  assert.equal(normaliseEmail('  Sam.Adviser@Example.COM \n'), 'sam.adviser@example.com');
  assert.equal(normaliseEmail(null), '');
});

test.describe('sign-in store', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_auth_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  let admin, pool, store, uid;
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    uid = (await asRole('hwp_owner', c => c.query(`insert into users (email, name) values ('sam@example.com', 'Sam') returning id`))).rows[0].id;
    await asRole('hwp_owner', c => c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [uid, DEFAULT_FIRM_ID]));
    pool = createPool(urlFor('hwp_app'), 2);
    store = createAuthStore({ pool, now: () => new Date(clock.t) });
  }, { timeout: 120000 });
  test.after(async () => { if (pool) await pool.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });

  test('an account is found by its email in any spelling; an unknown one is null; nothing is visible outside the store', async () => {
    const u = await store.findUserByEmail('  SAM@Example.com ');
    assert.equal(u.id, uid); assert.equal(u.email, 'sam@example.com'); assert.equal(u.password_hash, null); assert.equal(u.failed_attempts, 0);
    assert.equal(await store.findUserByEmail('nobody@example.com'), null);
    assert.equal((await pool.query('select count(*)::int n from users')).rows[0].n, 0, 'a bare query as the app role sees no account');
    assert.deepEqual(await store.memberships(uid), [{ firmId: DEFAULT_FIRM_ID, firmName: 'Default firm', role: 'adviser', roles: ['adviser'] }]);
  });

  test('failures count up with a progressive delay; a success clears them and records the time', async () => {
    assert.deepEqual(await store.recordFailure(uid), { failures: 1, delay: 0 });
    assert.deepEqual(await store.recordFailure(uid), { failures: 2, delay: 0 });
    assert.deepEqual(await store.recordFailure(uid), { failures: 3, delay: 1 });
    assert.deepEqual(await store.recordFailure(uid), { failures: 4, delay: 2 });
    let u = await store.findUser(uid);
    assert.equal(u.failed_attempts, 4); assert.equal(new Date(u.not_before).getTime(), clock.t + 2000);
    await store.recordSuccess(uid);
    u = await store.findUser(uid);
    assert.equal(u.failed_attempts, 0); assert.equal(u.not_before, null); assert.equal(new Date(u.last_sign_in_at).getTime(), clock.t);
  });

  test('a password hash is stored with its time; an event is written and can never be changed', async () => {
    await store.setPassword(uid, 'scrypt$131072$8$1$salt$hash');
    const u = await store.findUser(uid);
    assert.equal(u.password_hash, 'scrypt$131072$8$1$salt$hash'); assert.equal(new Date(u.password_set_at).getTime(), clock.t);
    await store.event({ userId: uid, email: 'SAM@example.com', event: 'sign_in', outcome: 'ok', ip: '10.0.0.1', userAgent: 'x'.repeat(400) });
    await store.event({ email: 'nobody@example.com', event: 'sign_in', outcome: 'unknown' });
    const ev = await store.events(uid);
    assert.equal(ev.length, 1); assert.equal(ev[0].event, 'sign_in'); assert.equal(ev[0].outcome, 'ok'); assert.equal(ev[0].ip, '10.0.0.1');
    await assert.rejects(store.withAuth(c => c.query('delete from auth_events')), /not allowed|permission denied/);
    await assert.rejects(store.withAuth(c => c.query(`update auth_events set outcome = 'x'`)), /not allowed|permission denied/);
    assert.equal((await asRole('hwp_owner', c => c.query('select count(*)::int n from auth_events'))).rows[0].n, 2, 'the owner reads every event, including the one for an unknown email');
  });
});
