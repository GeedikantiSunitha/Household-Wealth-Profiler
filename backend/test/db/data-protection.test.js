// Migrations 0012 (access log) and 0013 (retention, approved purge), tested in the database itself
// as the real roles: hwp_app (the server: NOSUPERUSER, NOBYPASSRLS, not the owner) and hwp_owner.
// What must hold even if application code has a bug: the access log can never be changed; nothing
// is deleted except by purge_household(), and that only for a pending request in the firm on the
// transaction, approved by someone else, after the retention period; firms never see each other.
// PostgreSQL only; skipped unless TEST_DATABASE_URL is set.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { migrate, pgClient } = require('../../../db/migrate.js');

const BASE_URL = require('../api/test-db.js').testDatabaseUrl();
const ROOT = path.join(__dirname, '..', '..', '..');
const A = 'f1a00000-0000-4000-8000-000000000001', B = '0f1e0000-0000-4000-8000-0000000000b3';

test.describe('access log and approved purge, in the database', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_dp_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  let admin, app, owner;
  // One transaction as the given client with the firm set; rolled back unless keep
  async function inFirm(c, firm, fn, { keep = false } = {}) {
    await c.query('begin');
    try { await c.query("select set_config('app.firm_id', $1, true)", [firm]); const r = await fn(); await c.query(keep ? 'commit' : 'rollback'); return r; }
    catch (e) { await c.query('rollback'); throw e; }
  }
  // A household in a firm with one version, two audit entries, a retention row and a pending request by ann
  async function household(firm, { until = '2020-01-01', requester = 'ann' } = {}) {
    const id = crypto.randomUUID();
    const req = await inFirm(app, firm, async () => {
      await app.query(`insert into households (id, version, doc, updated_at, firm_id) values ($1, 1, '{}', now(), $2)`, [id, firm]);
      await app.query(`insert into household_versions (household_id, version, doc, firm_id) values ($1, 1, '{}', $2)`, [id, firm]);
      await app.query(`insert into audit_log (household_id, entry, firm_id) values ($1, 'a', $2), ($1, 'b', $2)`, [id, firm]);
      await app.query(`insert into household_retention (household_id, firm_id, ended_on, retention_until, changed_by) values ($1, $2, ($3::date - interval '5 years')::date, $3, 'ann')`, [id, firm, until]);
      await app.query(`insert into access_log (firm_id, actor, action, household_id) values ($1, 'ann', 'read', $2)`, [firm, id]);
      return (await app.query(`insert into purge_requests (firm_id, household_id, retention_until, requested_by) values ($1, $2, $3, $4) returning id`, [firm, id, until, requester])).rows[0].id;
    }, { keep: true });
    return { id, req };
  }
  const count = async (firm, table, col, id) => inFirm(owner, firm, async () => (await owner.query(`select count(*)::int n from ${table} where ${col} = $1`, [id])).rows[0].n);

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('../api/test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    owner = new Client({ connectionString: urlFor('hwp_owner') }); await owner.connect();
    await migrate(pgClient(owner), { dir: path.join(ROOT, 'db', 'migrations') });
    await owner.query(`insert into firms (id, name) values ($1, 'Firm B')`, [B]);
    app = new Client({ connectionString: urlFor('hwp_app') }); await app.connect();
  }, { timeout: 120000 });
  test.after(async () => {
    for (const c of [app, owner]) if (c) await c.end();
    if (admin) { await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
  });

  test('every new table forces row-level security, is owned by hwp_owner, and shows the app role nothing without a firm', async () => {
    const t = (await admin.query(`select relname, relrowsecurity rls, relforcerowsecurity forced, pg_get_userbyid(relowner) owner from pg_class
      where relnamespace = $1::regnamespace and relname = any($2) order by relname`, [schema, ['access_log', 'household_retention', 'purge_requests']])).rows;
    assert.deepEqual(t.map(r => [r.relname, r.rls, r.forced, r.owner]), [['access_log', true, true, 'hwp_owner'], ['household_retention', true, true, 'hwp_owner'], ['purge_requests', true, true, 'hwp_owner']]);
    await household(A);
    for (const table of ['access_log', 'household_retention', 'purge_requests']) assert.equal((await app.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
    await assert.rejects(app.query(`insert into access_log (firm_id, actor, action) values ($1, 'x', 'read')`, [A]), /row-level security/);
  });

  test('the access log is kept: the app role cannot change or delete an entry, the owner deletes nothing; firm B sees none of firm A entries', async () => {
    const { id } = await household(A);
    await inFirm(app, A, async () => assert.rejects(app.query(`update access_log set actor = 'x' where household_id = $1`, [id]), /permission denied/));
    await inFirm(app, A, async () => assert.rejects(app.query(`delete from access_log where household_id = $1`, [id]), /permission denied/));
    // The owner has no delete policy on the access log: row-level security shows it no row to delete
    assert.equal(await inFirm(owner, A, async () => (await owner.query(`delete from access_log where household_id = $1`, [id])).rowCount), 0);
    assert.equal(await count(A, 'access_log', 'household_id', id), 1);
    await assert.rejects(owner.query('truncate access_log'), /not allowed/);
    assert.equal(await inFirm(app, B, async () => (await app.query('select count(*)::int n from access_log where household_id = $1', [id])).rows[0].n), 0);
    await inFirm(app, A, async () => assert.rejects(app.query(`insert into access_log (firm_id, actor, action) values ($1, 'x', 'read')`, [B]), /row-level security/), 'cannot write into another firm');
    await inFirm(app, A, async () => assert.rejects(app.query(`insert into access_log (firm_id, actor, action) values ($1, 'x', 'Not An Action')`, [A]), /check constraint/));
  });

  test('the app role deletes nothing itself, even with app.purge_household set; the owner deletes nothing without it', async () => {
    const { id } = await household(A);
    await inFirm(app, A, async () => {
      await app.query("select set_config('app.purge_household', $1, true)", [id]);
      for (const [t, col] of [['households', 'id'], ['household_versions', 'household_id'], ['audit_log', 'household_id'], ['household_retention', 'household_id'], ['purge_requests', 'household_id']]) {
        await app.query('savepoint s');
        await assert.rejects(app.query(`delete from ${t} where ${col} = $1`, [id]), /permission denied/, t);
        await app.query('rollback to savepoint s');
      }
    });
    // Without app.purge_household naming the household, the owner's purge policy shows it no row to delete
    assert.equal(await inFirm(owner, A, async () => (await owner.query('delete from audit_log where household_id = $1', [id])).rowCount), 0);
    assert.equal(await count(A, 'audit_log', 'household_id', id), 2);
    assert.equal(await count(A, 'households', 'id', id), 1);
  });

  test('the retention triggers themselves allow only the purge of the one household named: checked as a superuser, whom row-level security does not stop', async () => {
    const { id } = await household(A), other = await household(A);
    await inFirm(app, A, () => app.query(`insert into firm_record_versions (firm_id, version, doc) values ($1, 1, '{}')`, [A]), { keep: true });
    const q = (sql, params) => admin.query(sql.replace(/\b(firm_record_versions|household_versions|audit_log|households)\b/g, `${schema}.$1`), params);
    await admin.query('begin');
    try {
      await admin.query("select set_config('app.purge_household', $1, true)", [id]);
      for (const [label, sql, params] of [
        ['firm settings history is never purged', 'delete from firm_record_versions where firm_id = $1', [A]],
        ['a version is never rewritten', `update household_versions set doc = 'x' where household_id = $1`, [id]],
        ['another household is not the one named', 'delete from audit_log where household_id = $1', [other.id]],
      ]) {
        await admin.query('savepoint s');
        await assert.rejects(q(sql, params), /not allowed: records are kept/, label);
        await admin.query('rollback to savepoint s');
      }
      assert.equal((await q('delete from audit_log where household_id = $1', [id])).rowCount, 2, 'the named household: allowed');
    } finally { await admin.query('rollback'); }
    assert.equal(await count(A, 'audit_log', 'household_id', id), 2, 'rolled back');
  });

  test('a request is decided once, and only purge_household() marks it purged', async () => {
    const { req } = await household(A);
    await inFirm(app, A, async () => assert.rejects(app.query(`update purge_requests set status = 'purged' where id = $1`, [req]), /only by purge_household/));
    await inFirm(app, A, async () => assert.rejects(app.query(`update purge_requests set household_id = gen_random_uuid() where id = $1`, [req]), /permission denied/));
    await inFirm(app, A, () => app.query(`update purge_requests set status = 'rejected', decided_by = 'bob' where id = $1`, [req]), { keep: true });
    await inFirm(app, A, async () => assert.rejects(app.query(`update purge_requests set status = 'pending' where id = $1`, [req]), /already decided/));
  });

  test('purge_household refuses: no firm set, another firm, the requester approving, retention not ended, a request already decided', async () => {
    const { id, req } = await household(A);
    await assert.rejects(app.query(`select purge_household($1, 'bob', null, '')`, [req]), /no firm set/);
    await inFirm(app, B, async () => assert.rejects(app.query(`select purge_household($1, 'bob', null, '')`, [req]), /no purge request/));
    await inFirm(app, A, async () => assert.rejects(app.query(`select purge_household($1, 'ann', null, '')`, [req]), /different person/));
    await inFirm(app, A, async () => assert.rejects(app.query(`select purge_household($1, '', null, '')`, [req]), /different person/));
    const young = await household(A, { until: new Date(Date.now() + 86400e3 * 30).toISOString().slice(0, 10) });
    await inFirm(app, A, async () => assert.rejects(app.query(`select purge_household($1, 'bob', null, '')`, [young.req]), /has not ended/));
    // "today" is the database's own date (what purge_household compares with), not this machine's UTC date: the two differ for some hours of every day
    const today = await household(A, { until: (await app.query('select current_date::text as d')).rows[0].d });
    await inFirm(app, A, async () => assert.rejects(app.query(`select purge_household($1, 'bob', null, '')`, [today.req]), /has not ended/), 'the last day of retention is still within it');
    const done = await household(A);
    await inFirm(app, A, () => app.query(`update purge_requests set status = 'rejected' where id = $1`, [done.req]), { keep: true });
    await inFirm(app, A, async () => assert.rejects(app.query(`select purge_household($1, 'bob', null, '')`, [done.req]), /already decided/));
    assert.equal(await count(A, 'households', 'id', id), 1, 'nothing was deleted');
  });

  test('a temporary table the caller makes cannot stand in for a real one (search_path pins pg_temp last)', async () => {
    const young = await household(A, { until: new Date(Date.now() + 86400e3 * 30).toISOString().slice(0, 10) });
    await inFirm(app, A, async () => {
      await app.query(`create temp table household_retention (household_id uuid, firm_id uuid, ended_on date, retention_until date, changed_by text, changed_at timestamptz)`);
      await app.query(`insert into pg_temp.household_retention values ($1, $2, '2000-01-01', '2005-01-01', 'x', now())`, [young.id, A]);
      await assert.rejects(app.query(`select purge_household($1, 'bob', null, '')`, [young.req]), /has not ended/, 'the real retention row was read');
    });
    assert.equal(await count(A, 'households', 'id', young.id), 1);
  });

  test('approved: one household with every version, its audit and its retention row go, in its firm only; the register and access log stay', async () => {
    const keepA = await household(A), keepB = await household(B), { id, req } = await household(A);
    const counts = await inFirm(app, A, async () => (await app.query(`select purge_household($1, 'bob', null, 'ok') c`, [req])).rows[0].c, { keep: true });
    assert.deepEqual(counts, { households: 1, versions: 1, auditEntries: 2, retention: 1 });
    for (const [t, col] of [['households', 'id'], ['household_versions', 'household_id'], ['audit_log', 'household_id'], ['household_retention', 'household_id']]) assert.equal(await count(A, t, col, id), 0, t);
    assert.equal(await count(A, 'access_log', 'household_id', id), 1, 'the access log is kept');
    const reg = await inFirm(owner, A, async () => (await owner.query('select status, decided_by, counts from purge_requests where id = $1', [req])).rows[0]);
    assert.deepEqual(reg, { status: 'purged', decided_by: 'bob', counts });
    assert.equal(await count(A, 'households', 'id', keepA.id), 1); assert.equal(await count(B, 'households', 'id', keepB.id), 1);
    assert.equal(await inFirm(app, A, async () => (await app.query("select current_setting('app.purge_household', true) v")).rows[0].v || ''), '', 'the purge flag does not outlive its transaction');
  });

  test('only the app role (and the owner) may call purge_household; PUBLIC may not', async () => {
    const r = (await admin.query(`select has_function_privilege('hwp_app', p.oid, 'execute') app, coalesce(array_to_string(p.proacl, ','), '') acl
      from pg_proc p where p.proname = 'purge_household' and p.pronamespace = $1::regnamespace`, [schema])).rows[0];
    assert.equal(r.app, true);
    assert.ok(!/(^|,)=X/.test(r.acl), 'no grant to PUBLIC: ' + r.acl);
  });
});
