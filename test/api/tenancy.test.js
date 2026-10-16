// Cross-tenant isolation (Phase 1): every firm's data is invisible to every other firm, enforced
// in the database by row-level security, so it holds even if application code has a bug.
// PostgreSQL only: the policies live there. Runs as the real application role, hwp_app
// (NOSUPERUSER, NOBYPASSRLS, not the table owner), created on the scratch cluster with a
// throwaway password for this run; migrations run as hwp_owner.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createStore, DEFAULT_FIRM_ID } = require('../../backend/src/repositories');
const { createSealer } = require('../../backend/src/crypto/seal.js');
const { createHouseholdService } = require('../../backend/src/services/households.js');
const { createFirmService } = require('../../backend/src/services/firm.js');
const { createPriceService } = require('../../backend/src/services/prices.js');
const { createApp } = require('../../backend/src/app.js');
const { migrate, pgClient } = require('../../db/migrate.js');
const H = require('../../packages/core/core.js');

const BASE_URL = require('./test-db.js').testDatabaseUrl();
const ROOT = path.join(__dirname, '..', '..');
const FIRM_TABLES = ['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'idempotency_keys', 'firms'];
const rec = (id, version, name, by = 'sam') => ({ id, version, state: { household: { name, reference: 'REF-' + id.slice(0, 4) } }, createdAt: '2026-10-10T09:00:00.000Z', createdBy: 'sam', updatedAt: `2026-10-10T09:0${version}:00.000Z`, updatedBy: by });

test.describe('tenant isolation', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_tenancy_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  let admin, store, A, B;

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    await require('./test-db.js').ensureRoles(admin, PW);
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    A = DEFAULT_FIRM_ID; B = crypto.randomUUID();
    await asRole('hwp_owner', c => c.query(`insert into firms (id, name) values ($1, 'Firm B')`, [B]));
    store = createStore({ databaseUrl: urlFor('hwp_app'), databasePoolMax: 1, root: ROOT }, createSealer(crypto.randomBytes(32)));
    await store.ready();
  }, { timeout: 120000 });
  test.after(async () => {
    if (store) await store.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  test('roles: hwp_app is not a superuser, cannot bypass RLS and owns no table; every firm table forces RLS', async () => {
    const role = (await admin.query(`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'hwp_app'`)).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const tables = (await admin.query(`select relname, relrowsecurity as rls, relforcerowsecurity as forced, pg_get_userbyid(relowner) as owner
      from pg_class where relnamespace = $1::regnamespace and relkind = 'r' and relname = any($2)`, [schema, FIRM_TABLES])).rows;
    assert.equal(tables.length, FIRM_TABLES.length, 'every firm table exists: ' + tables.map(t => t.relname).join());
    for (const t of tables) { assert.equal(t.rls, true, t.relname + ' rls'); assert.equal(t.forced, true, t.relname + ' forced'); assert.equal(t.owner, 'hwp_owner', t.relname + ' owner'); }
  });

  test('as the app role with no firm set: every firm table answers zero rows and refuses an insert', async () => {
    await asRole('hwp_app', async c => {
      for (const t of FIRM_TABLES) assert.equal((await c.query(`select count(*)::int n from ${t}`)).rows[0].n, 0, t);
      await assert.rejects(c.query(`insert into households (id, version, doc, updated_at, firm_id) values ($1, 1, 'x', now(), $2)`, [crypto.randomUUID(), A]), /row-level security/);
      await assert.rejects(c.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'x', now())`, [crypto.randomUUID()]), /row-level security|not-null/);
    });
  });

  test('two firms through every repository method: nothing of A is visible or changeable from B', async () => {
    const sa = store.forFirm(A), sb = store.forFirm(B);
    const id = crypto.randomUUID();
    assert.deepEqual(await sa.create(rec(id, 1, 'Alpha'), [{ ts: 't1', user: 'sam', field: 'created', from: '', to: 'Alpha' }]), { id, version: 1 });
    assert.equal((await sa.get(id)).version, 1);
    assert.equal(await sb.get(id), null, 'get');
    assert.deepEqual(await sb.list(), [], 'list');
    assert.deepEqual(await sb.audit(id), [], 'audit');
    assert.deepEqual(await sb.versions(id), [], 'versions');
    assert.equal(await sb.update(id, cur => ({ result: cur, next: cur && rec(id, 2, 'Stolen', 'eve') })), null, 'update sees nothing and writes nothing');
    assert.equal((await sa.get(id)).version, 1, 'A is untouched');
    // firm settings are per firm
    await sa.firm.update(() => ({ result: 1, next: { version: 1, settings: { firm: { name: 'Firm A' } }, updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'sam' }, audit: [{ ts: '2026-10-10T10:00:00.000Z', user: 'sam', field: 'firm.name', from: '', to: 'Firm A', version: 1 }] }));
    assert.equal(await sb.firm.get(), null, 'firm settings');
    assert.deepEqual(await sb.firm.audit(), [], 'firm audit');
    assert.equal((await sa.firm.get()).settings.firm.name, 'Firm A');
    // idempotency keys are per firm: the same user and key in B is B's own create
    const ka = await sa.create(rec(crypto.randomUUID(), 1, 'Keyed'), [], { user: 'sam', key: 'key-shared-1' });
    const kb = await sb.create(rec(crypto.randomUUID(), 1, 'Keyed'), [], { user: 'sam', key: 'key-shared-1' });
    assert.notEqual(ka.id, kb.id);
    assert.equal(await sa.get(kb.id), null); assert.equal(await sb.get(ka.id), null);
    assert.deepEqual((await sb.list()).map(r => r.id), [kb.id]);
  });

  test('a pooled connection reused across firms carries nothing over; a bare query on it sees nothing', async () => {
    // databasePoolMax is 1: every call below runs on the same connection
    const sa = store.forFirm(A), sb = store.forFirm(B);
    for (let i = 0; i < 3; i++) {
      assert.ok((await sa.list()).length >= 2, 'A sees its own');
      assert.equal((await sb.list()).length, 1, 'B sees only its own');
    }
    for (const t of FIRM_TABLES) assert.equal((await store.raw(`select count(*)::int n from ${t}`)).rows[0].n, 0, `${t}: no firm set outside a scoped call`);
    // After a transaction PostgreSQL leaves the setting null or empty; either way no firm
    assert.equal((await store.raw(`select current_setting('app.firm_id', true) as f`)).rows[0].f || '', '', 'the setting does not outlive its transaction');
  });

  test('the app role, with a firm set, reads nothing of another firm; the owner reads every firm (ciphertext) but inserts nothing', async () => {
    const a = (await store.forFirm(A).list()).length, b = (await store.forFirm(B).list()).length;
    assert.ok(a >= 2 && b >= 1, 'both firms hold data');
    await asRole('hwp_app', async c => {
      await c.query('begin');
      await c.query("select set_config('app.firm_id', $1, true)", [A]);
      assert.equal((await c.query('select count(*)::int n from households where firm_id = $1', [B])).rows[0].n, 0, "firm B's rows");
      assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, a, "only firm A's rows");
      assert.equal((await c.query('select count(*)::int n from firms')).rows[0].n, 1, 'only its own firm');
      await c.query('commit');
    });
    await asRole('hwp_owner', async c => {
      assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, a + b, 'the owner reads across firms');
      assert.ok((await c.query('select doc from households limit 1')).rows[0].doc.startsWith('enc:v'), 'ciphertext only');
      await assert.rejects(c.query(`insert into households (id, version, doc, updated_at, firm_id) values ($1, 1, 'x', now(), $2)`, [crypto.randomUUID(), A]), /row-level security/, 'no insert policy for the owner');
      assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, a + b, 'nothing was inserted');
    });
  });

  test('a row with no firm cannot be inserted, as the app role or as the owner', async () => {
    const before = await asRole('hwp_owner', async c => (await c.query('select count(*)::int n from households')).rows[0].n);
    await asRole('hwp_app', async c => {
      await c.query('begin');
      await c.query("select set_config('app.firm_id', $1, true)", [A]);
      await assert.rejects(c.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'x', now())`, [crypto.randomUUID()]), /not-null|row-level security/);
      await c.query('rollback');
    });
    await asRole('hwp_owner', async c => {
      await assert.rejects(c.query(`insert into households (id, version, doc, updated_at) values ($1, 1, 'x', now())`, [crypto.randomUUID()]), /not-null|row-level security/);
      assert.equal((await c.query('select count(*)::int n from households')).rows[0].n, before);
    });
  });

  const AUTH_TABLES = ['sessions', 'recovery_codes', 'one_time_tokens', 'access_requests', 'auth_events'];
  test('sign-in tables: row security forced; the app role sees and writes accounts, sessions and events only with app.auth set for the transaction', async () => {
    const uid = (await asRole('hwp_owner', c => c.query(`insert into users (email, name) values ('sam@example.com', 'Sam') returning id`))).rows[0].id;
    await asRole('hwp_app', async c => {
      for (const t of ['users', 'memberships', ...AUTH_TABLES]) assert.equal((await c.query(`select count(*)::int n from ${t}`)).rows[0].n, 0, `${t}: nothing without app.auth`);
      await assert.rejects(c.query(`insert into sessions (id_hash, user_id, stage, expires_at) values ('h', $1, 'password', now())`, [uid]), /row-level security/);
      await c.query('begin'); await c.query("select set_config('app.auth', 'on', true)");
      assert.equal((await c.query('select count(*)::int n from users')).rows[0].n, 1, 'the account is visible to sign-in code');
      await c.query(`insert into sessions (id_hash, user_id, stage, expires_at) values ('h', $1, 'password', now() + interval '1 hour')`, [uid]);
      await c.query(`insert into auth_events (user_id, event, outcome) values ($1, 'sign_in', 'ok')`, [uid]);
      await c.query(`update users set failed_attempts = 2 where id = $1`, [uid]);
      await c.query('commit');
      assert.equal((await c.query('select count(*)::int n from sessions')).rows[0].n, 0, 'nothing visible once the transaction ended');
      await assert.rejects(c.query(`update users set email = 'x@example.com' where id = $1`, [uid]), /permission denied/, 'the email is not the app role\'s to change');
    });
    await asRole('hwp_owner', async c => {
      assert.equal((await c.query('select count(*)::int n from sessions')).rows[0].n, 1, 'the owner reads sessions');
      await assert.rejects(c.query('delete from auth_events'), /not allowed/, 'events are kept');
      assert.equal((await c.query('select failed_attempts from users where id = $1', [uid])).rows[0].failed_attempts, 2);
    });
  });

  test('every API endpoint: written under firm A, invisible under firm B', async () => {
    const households = createHouseholdService({ store, HWP: H });
    const firm = createFirmService({ store, HWP: H });
    const authenticate = req => ({ user: 'sam', firmId: req.headers['x-firm'] });
    const { server } = createApp({ config: { hsts: false, key: Buffer.alloc(32), root: ROOT }, households, firm, prices: createPriceService({ key: '' }), authenticate, ready: () => store.ready() });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (firmId, method, p, body, extra = {}) => fetch(base + p, { method, headers: { Authorization: 'x', 'X-Firm': firmId, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body && JSON.stringify(body) });
    try {
      const st = H.blank(); st.household.name = 'Firm A client';
      const { id } = await (await call(A, 'POST', '/api/households', { state: st })).json();
      assert.equal((await call(B, 'GET', '/api/households/' + id)).status, 404, 'GET record');
      assert.equal((await call(B, 'GET', `/api/households/${id}/audit`)).status, 404, 'GET audit');
      assert.equal((await call(B, 'PUT', '/api/households/' + id, { version: 1, state: st })).status, 404, 'PUT');
      assert.ok(!(await (await call(B, 'GET', '/api/households')).json()).some(h => h.id === id), 'list');
      assert.ok((await (await call(A, 'GET', '/api/households')).json()).some(h => h.id === id), 'A still lists it');
      const fa = await (await call(A, 'GET', '/api/firm')).json();
      fa.settings.firm.name = 'Only A';
      assert.equal((await call(A, 'PUT', '/api/firm', { version: fa.version, settings: fa.settings })).status, 200);
      const fb = await (await call(B, 'GET', '/api/firm')).json();
      assert.notEqual(fb.settings.firm.name, 'Only A', 'firm settings'); assert.equal(fb.version, 0);
      assert.ok(!(await (await call(B, 'GET', '/api/firm/audit')).json()).some(a => a.to === 'Only A'), 'firm audit');
      const key = 'api-key-' + crypto.randomUUID().slice(0, 8);
      const ra = await (await call(A, 'POST', '/api/households', { state: st }, { 'Idempotency-Key': key })).json();
      const rb = await (await call(B, 'POST', '/api/households', { state: st }, { 'Idempotency-Key': key })).json();
      assert.notEqual(ra.id, rb.id, 'idempotency keys are per firm');
      assert.equal((await call(B, 'GET', '/api/households/' + ra.id)).status, 404, "A's household stays invisible to B");
      // B reusing A's key with a different request: a plain 201 of its own, never a 422 that would reveal A used the key
      const key2 = 'api-key-' + crypto.randomUUID().slice(0, 8);
      const st2 = H.blank(); st2.household.name = 'Only in B'; st2.household.reference = 'B-' + key2;
      const ra2 = await (await call(A, 'POST', '/api/households', { state: st }, { 'Idempotency-Key': key2 })).json();
      const r2 = await call(B, 'POST', '/api/households', { state: st2 }, { 'Idempotency-Key': key2 });
      assert.equal(r2.status, 201); const rb2 = await r2.json();
      assert.notEqual(rb2.id, ra2.id);
      assert.ok(!(await (await call(B, 'GET', '/api/households')).json()).some(h => h.id === ra2.id || h.id === ra.id), "B's list holds nothing of A");
      const mism = await call(A, 'POST', '/api/households', { state: st2 }, { 'Idempotency-Key': key2 });
      assert.equal(mism.status, 422, "A's key with a different request is refused within A");
    } finally { server.close(); }
  });

  test('after 0011 the app role can add an account and a membership inside sign-in, but cannot change or delete accounts, and still reads nothing across firms; since 0014 it changes a membership only for the firm it works in', async () => {
    await asRole('hwp_app', async c => {
      await c.query('begin'); await c.query("select set_config('app.auth', 'on', true)");
      const uid = (await c.query(`insert into users (email, name) values ('invited@example.com', 'Invited') returning id`)).rows[0].id;
      await c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'adviser')`, [uid, B]);
      await c.query('commit');
      // sign-in context on, and the firm set to A: B's client data stays invisible, and A's is visible as usual
      await c.query('begin'); await c.query("select set_config('app.auth', 'on', true)"); await c.query("select set_config('app.firm_id', $1, true)", [A]);
      assert.equal((await c.query('select count(*)::int n from households where firm_id = $1', [B])).rows[0].n, 0, "B's households");
      assert.equal((await c.query('select count(*)::int n from firm_records where firm_id = $1', [B])).rows[0].n, 0, "B's firm settings");
      assert.equal((await c.query('select count(*)::int n from firms')).rows[0].n, 2, 'firm names are readable inside sign-in (the firm picker); nothing else of a firm');
      await c.query('commit');
      for (const [sql, what] of [["update users set email = 'x@example.com'", 'an email'], ["update users set name = 'x'", 'a name'], ['update users set active = false', 'deactivation'],
        ['delete from users', 'deleting accounts'], ['delete from memberships', 'deleting memberships'], ['delete from sessions', 'deleting sessions'], ['delete from auth_events', 'deleting events']]) {
        await c.query('begin'); await c.query("select set_config('app.auth', 'on', true)");
        await assert.rejects(c.query(sql), /permission denied/, what + ' is not the app role\'s, even inside sign-in');
        await c.query('rollback');
      }
      // Phase 3 (migration 0014): a membership's role and active flag can be changed, but only for the firm the transaction works in.
      // With no firm set nothing changes (it fails closed); with a firm set only that firm's memberships change.
      const roles = async () => (await asRole('hwp_owner', o => o.query('select firm_id, role, active from memberships order by firm_id, user_id'))).rows;
      const before = await roles();
      await c.query('begin'); await c.query("select set_config('app.auth', 'on', true)");
      assert.equal((await c.query("update memberships set role = 'admin'")).rowCount, 0, 'no firm set: no membership changes');
      assert.equal((await c.query('update memberships set active = false')).rowCount, 0, 'no firm set: no membership is deactivated');
      await c.query('rollback');
      await c.query('begin'); await c.query("select set_config('app.auth', 'on', true)"); await c.query("select set_config('app.firm_id', $1, true)", [B]);
      assert.equal((await c.query("update memberships set role = 'compliance'")).rowCount, before.filter(m => m.firm_id === B).length, "working for B: exactly B's memberships");
      await c.query('rollback');
      assert.deepEqual(await roles(), before, 'nothing was committed');
    });
    assert.equal((await asRole('hwp_owner', c => c.query(`select role from memberships m join users u on u.id = m.user_id where u.email = 'invited@example.com'`))).rows[0].role, 'adviser');
  });

  test("firm B reusing firm A's key: no replay, no sign the key was used, and B's own repeat rule applies to B's record only", async () => {
    const sa = store.forFirm(A), sb = store.forFirm(B);
    const ia = { user: 'sam', key: 'key-shared-2', request: 'request of A' };
    const ka2 = await sa.create(rec(crypto.randomUUID(), 1, 'Keyed A'), [], ia);
    assert.equal(await sb.recall(ia), null, "B recalls nothing for A's key and request");
    assert.equal(await sb.recall({ ...ia, request: 'request of B' }), null, 'and is not told the key was used (no 422)');
    const kb2 = await sb.create(rec(crypto.randomUUID(), 1, 'Keyed B'), [], { ...ia, request: 'request of B' });
    assert.notEqual(kb2.id, ka2.id);
    assert.deepEqual(await sb.recall({ ...ia, request: 'request of B' }), kb2, "B's own reply");
    await assert.rejects(sb.recall(ia), { status: 422 }, "B's key now belongs to B's request, not A's");
    assert.deepEqual(await sa.recall(ia), ka2, 'A is unaffected');
  });
});
