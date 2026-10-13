// The request pipeline with cookie sessions on PostgreSQL: who gets in, what a half-finished
// sign-in (password done, second step pending) can reach, the CSRF token on writes, and what
// /api/me says. Sessions are issued directly here; the sign-in routes themselves are covered by
// auth-api.test.js. Runs when TEST_DATABASE_URL points at a scratch database, in a schema of its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createApp } = require('../../apps/api/src/app.js');
const { createAuth } = require('../../apps/api/src/auth');
const { createAuthStore } = require('../../apps/api/src/auth/store.js');
const { createSessions } = require('../../apps/api/src/auth/sessions.js');
const { createPool } = require('../../apps/api/src/db/pool.js');
const { migrate, pgClient } = require('../../db/migrate.js');
const { DEFAULT_FIRM_ID } = require('../../apps/api/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const ID = '00000000-0000-4000-8000-000000000001';

test.describe('sessions in the request pipeline', { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const { Client } = require('pg');
  const schema = 'hwp_sess_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const asRole = async (user, fn) => { const c = new Client({ connectionString: urlFor(user) }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  let admin, pool, store, sessions, server, base, uid, calls;
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const households = {
    list: async ctx => { calls.push(['list', ctx.user, ctx.firmId]); return [{ id: ID }]; },
    create: async ctx => { calls.push(['create', ctx.user]); return { id: ID, version: 1 }; },
    get: async (ctx, id) => id === ID ? { id: ID, version: 1 } : null,
    audit: async (ctx, id) => id === ID ? [] : null,
    save: async (ctx, id, body) => { calls.push(['save', ctx.user]); return id === ID ? { version: 2, changes: 1 } : { notFound: true }; },
  };
  const firm = { get: async () => ({ version: 0, settings: {}, updatedAt: '', updatedBy: '' }), audit: async () => [], save: async () => ({ version: 1, changes: 1 }) };

  test.before(async () => {
    admin = new Client({ connectionString: BASE_URL }); await admin.connect();
    for (const r of ['hwp_owner', 'hwp_app']) {
      await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nosuperuser nobypassrls; end if; end $$`);
      await admin.query(`alter role ${r} login password '${PW}'`);
    }
    await admin.query(`create schema ${schema} authorization hwp_owner`);
    await admin.query(`grant usage on schema ${schema} to hwp_app`);
    await asRole('hwp_owner', c => migrate(pgClient(c), { dir: path.join(ROOT, 'db', 'migrations') }));
    uid = (await asRole('hwp_owner', c => c.query(`insert into users (email, name) values ('sam@example.com', 'Sam Adviser') returning id`))).rows[0].id;
    await asRole('hwp_owner', c => c.query(`insert into memberships (user_id, firm_id, role) values ($1, $2, 'admin')`, [uid, DEFAULT_FIRM_ID]));
    pool = createPool(urlFor('hwp_app'), 2);
    store = createAuthStore({ pool, now: () => new Date(clock.t) });
    sessions = createSessions({ store, secret: crypto.randomBytes(32), idleMs: 30 * 60e3, absoluteMs: 12 * 3600e3, secure: false, now: () => clock.t });
    const { authenticate } = createAuth({ users: new Map(), clientIpHeader: '' }, { authStore: store, sessions });
    ({ server } = createApp({ config: { hsts: false, key: Buffer.alloc(32), root: ROOT }, households, firm, prices: { enabled: false }, authenticate, ready: async () => {} }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 120000 });
  test.after(async () => { if (server) server.close(); if (pool) await pool.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });
  test.beforeEach(() => { calls = []; });

  const J = { 'Content-Type': 'application/json' };
  const cookieOf = s => s.cookie.split(';')[0];
  const call = (method, p, { session, body, headers = {} } = {}) => fetch(base + p, { method, headers: { ...(session ? { Cookie: cookieOf(session) } : {}), ...(body ? J : {}), ...headers }, body });

  test('no cookie: 401 sign_in_required with the Basic challenge absent (no Basic users configured)', async () => {
    const r = await call('GET', '/api/me');
    assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'Sign in required', code: 'sign_in_required' });
  });

  test('a full session reaches the API and the files; /api/me says who, which firm, the role, the stage and the CSRF token', async () => {
    const s = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full', ip: '10.0.0.1', userAgent: 'test' });
    const me = await (await call('GET', '/api/me', { session: s })).json();
    assert.deepEqual(me, { user: 'sam@example.com', email: 'sam@example.com', name: 'Sam Adviser', firmId: DEFAULT_FIRM_ID, firmName: 'Default firm', role: 'admin', stage: 'full', csrf: s.csrf, encrypted: true, production: false });
    assert.equal((await call('GET', '/api/households', { session: s })).status, 200);
    assert.deepEqual(calls, [['list', 'sam@example.com', DEFAULT_FIRM_ID]], 'services see the email as the user and the session\'s firm');
    assert.equal((await call('GET', '/', { session: s })).status, 200);
  });

  test('every route except the second-step and sign-out routes refuses a password-stage session (401 second_step_required)', async () => {
    const s = await sessions.issue({ userId: uid, stage: 'password' });
    const routes = [['GET', '/api/me'], ['GET', '/api/households'], ['POST', '/api/households', '{"state":{}}'], ['GET', `/api/households/${ID}`], ['PUT', `/api/households/${ID}`, '{"version":1,"state":{}}'],
      ['GET', `/api/households/${ID}/audit`], ['GET', '/api/firm'], ['PUT', '/api/firm', '{"version":0,"settings":{}}'], ['GET', '/api/firm/audit'], ['GET', '/api/prices?symbol=VWRL.LON'], ['GET', '/'], ['GET', '/core.js'], ['GET', '/api/nope'],
      ['POST', '/api/auth/firm', '{}'], ['POST', '/api/auth/sign-out-all', '{}'], ['POST', '/api/auth/password', '{}']];
    for (const [m, p, body] of routes) {
      const r = await call(m, p, { session: s, body, headers: { 'X-CSRF-Token': s.csrf } });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.deepEqual(await r.json(), { error: 'Finish signing in: enter the code from your authenticator app', code: 'second_step_required' }, `${m} ${p}`);
    }
    assert.deepEqual(calls, [], 'no service was reached');
    // The second-step routes and sign-out are the only ones such a session may call (they do not exist yet in this step, so 404, never 401)
    for (const p of ['/api/auth/totp', '/api/auth/enrol', '/api/auth/enrol/confirm', '/api/auth/recovery', '/api/auth/sign-out'])
      assert.notEqual((await call('POST', p, { session: s, body: '{}', headers: { 'X-CSRF-Token': s.csrf } })).status, 401, p);
  });

  test('writes with a cookie session need the CSRF token bound to that session; reads do not', async () => {
    const s = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    const other = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    let r = await call('PUT', `/api/households/${ID}`, { session: s, body: '{"version":1,"state":{}}' });
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'Request refused: the sign-in token is missing or stale. Reload the page.', code: 'csrf' });
    r = await call('PUT', `/api/households/${ID}`, { session: s, body: '{"version":1,"state":{}}', headers: { 'X-CSRF-Token': other.csrf } });
    assert.equal(r.status, 403, 'another session\'s token');
    r = await call('PUT', `/api/households/${ID}`, { session: s, body: '{"version":1,"state":{}}', headers: { 'X-CSRF-Token': s.csrf } });
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/api/households', { session: s })).status, 200, 'a read needs no token');
    assert.deepEqual(calls, [['save', 'sam@example.com'], ['list', 'sam@example.com', DEFAULT_FIRM_ID]]);
  });

  test('the session is in the database, hashed; revoking it, or deactivating the account, ends access on the next request', async () => {
    const s = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full', ip: '10.0.0.9', userAgent: 'Browser/1' });
    const rows = await asRole('hwp_owner', c => c.query('select stage, ip, user_agent, revoked_at from sessions where id_hash = $1', [crypto.createHash('sha256').update(s.id).digest('hex')]));
    assert.equal(rows.rows.length, 1, 'stored under the hash of the id'); assert.equal(rows.rows[0].ip, '10.0.0.9'); assert.equal(rows.rows[0].user_agent, 'Browser/1'); assert.equal(rows.rows[0].revoked_at, null);
    assert.equal((await pool.query('select count(*)::int n from sessions')).rows[0].n, 0, 'invisible to a bare query as the app role');
    assert.equal((await call('GET', '/api/me', { session: s })).status, 200);
    await sessions.revokeAll(uid, {});
    assert.equal((await call('GET', '/api/me', { session: s })).status, 401, 'revoked');
    const t = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    assert.equal((await call('GET', '/api/me', { session: t })).status, 200);
    await asRole('hwp_owner', c => c.query('update users set active = false where id = $1', [uid]));
    assert.equal((await call('GET', '/api/me', { session: t })).status, 401, 'deactivated: the next request is refused');
    await asRole('hwp_owner', c => c.query('update users set active = true where id = $1', [uid]));
    assert.equal((await call('GET', '/api/me', { session: t })).status, 401, 'and the session itself was ended, so reactivation does not revive it');
  });

  test('idle and absolute limits apply on the server clock', async () => {
    const s = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    clock.t += 31 * 60e3;
    assert.equal((await call('GET', '/api/me', { session: s })).status, 401, 'idle for 31 minutes');
    const t = await sessions.issue({ userId: uid, firmId: DEFAULT_FIRM_ID, stage: 'full' });
    for (let i = 0; i < 25; i++) { clock.t += 29 * 60e3; if ((await call('GET', '/api/me', { session: t })).status !== 200) break; }
    assert.equal((await call('GET', '/api/me', { session: t })).status, 401, 'past 12 hours despite activity');
  });
});
