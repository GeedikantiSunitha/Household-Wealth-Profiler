// Supabase edition: runs the real migration in PGlite (Postgres in WebAssembly) with stand-ins for
// Supabase's auth schema and roles, and drives the real Edge Function handler against it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../public/core.js');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const ORIGIN = 'https://app.example.co.uk';
let pg, handle;

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant references, select on auth.users to service_role;`;

// Every API query runs as service_role, as it does on Supabase, so grants are tested too.
async function q(sql, params = []) {
  await pg.exec('set role service_role');
  try { return (await pg.query(sql, params)).rows; } finally { await pg.exec('reset role'); }
}
const one = async (sql, params) => (await q(sql, params))[0] || null;
const db = {
  member: id => one(`select m.*, f.name firm_name, f.status firm_status, f.seats from members m join firms f on f.id = m.firm_id where m.user_id = $1`, [id]),
  listHouseholds: firm => q(`select * from households where firm_id = $1 order by updated_at desc`, [firm]),
  getHousehold: (id, firm) => one(`select * from households where id = $1 and firm_id = $2`, [id, firm]),
  audit: (id, firm, n) => q(`select * from audit_log where household_id = $1 and firm_id = $2 order by id desc limit $3`, [id, firm, n]),
  createHousehold: async a => (await one(`select create_household($1, $2::jsonb, $3::jsonb, $4, $5) r`, [a.firm, JSON.stringify(a.state), JSON.stringify(a.summary), a.userId, a.user])).r,
  saveHousehold: async a => (await one(`select save_household($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8) r`,
    [a.id, a.firm, a.expected, JSON.stringify(a.state), JSON.stringify(a.summary), JSON.stringify(a.changes), a.userId, a.user])).r,
  listMembers: firm => q(`select * from members where firm_id = $1 order by created_at`, [firm]),
  async inviteMember(a) {
    if ((await pg.query(`select 1 from auth.users where email = $1`, [a.email])).rows.length) return { conflict: true };
    const u = (await pg.query(`insert into auth.users (email) values ($1) returning id`, [a.email])).rows[0];
    return { member: await one(`insert into members (user_id, firm_id, email, display_name, role) values ($1, $2, $3, $4, $5) returning *`, [u.id, a.firm, a.email, a.name, a.role]) };
  },
  updateMember: (firm, uid, patch) => one(`update members set active = coalesce($3, active), role = coalesce($4, role) where firm_id = $1 and user_id = $2 returning *`,
    [firm, uid, patch.active ?? null, patch.role ?? null]),
};

const TOKENS = {};
const deps = { HWP: H, db, origins: [ORIGIN], requireMfa: true, inviteRedirect: ORIGIN + '/?setpw=1', verify: async t => TOKENS[t] || null };
async function call(method, p, { token, body, origin } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await handle(new Request('http://edge/api' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const F = {};
async function addUser(key, firm, name, role, aal = 'aal2') {
  const u = (await pg.query(`insert into auth.users (email) values ($1) returning id`, [key + '@example.co.uk'])).rows[0];
  await pg.query(`insert into members (user_id, firm_id, email, display_name, role) values ($1, $2, $3, $4, $5)`, [u.id, firm, key + '@example.co.uk', name, role]);
  TOKENS[key] = { userId: u.id, aal };
  return u.id;
}

test.before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  ({ handle } = await import('../supabase/functions/api/handler.mjs'));
  pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  for (const f of fs.readdirSync(MIGRATIONS).sort()) await pg.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  for (const [k, name, seats, status] of [['a', 'Alder Wealth', 3, 'active'], ['b', 'Birch Partners', 5, 'active'], ['s', 'Suspended Ltd', 5, 'suspended']])
    F[k] = (await pg.query(`insert into firms (name, seats, status) values ($1, $2, $3) returning id`, [name, seats, status])).rows[0].id;
  await addUser('sam', F.a, 'Sam Adviser', 'admin');
  await addUser('chris', F.a, 'Chris Reviewer', 'adviser');
  await addUser('bea', F.b, 'Bea Birch', 'admin');
  await addUser('sue', F.s, 'Sue', 'admin');
  await addUser('nomfa', F.a, 'No MFA', 'adviser', 'aal1');
  TOKENS.stranger = { userId: '00000000-0000-4000-8000-000000000000', aal: 'aal2' };
});
test.after(() => pg && pg.close());

test('the function uses the same core.js as the browser', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/core.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'public/core.js'), 'utf8'),
    'supabase/functions/_shared/core.js is out of date: run npm run sync:supabase');
});

test('sign-in, two-step verification and firm status are enforced', async () => {
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('GET', '/me', { token: 'forged' })).status, 401);
  const nomfa = await call('GET', '/households', { token: 'nomfa' });
  assert.equal(nomfa.status, 403); assert.equal(nomfa.body.code, 'mfa_required');
  assert.equal((await call('GET', '/me', { token: 'stranger' })).status, 403);
  assert.match((await call('GET', '/me', { token: 'sue' })).body.error, /suspended/);
  assert.deepEqual((await call('GET', '/me', { token: 'sam' })).body, { user: 'Sam Adviser', email: 'sam@example.co.uk', role: 'admin', firm: 'Alder Wealth', seats: 3, encrypted: true });
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('create, open, save, version conflict and audit trail', async () => {
  const c = await call('POST', '/households', { token: 'sam', body: { state: H.sample() } });
  assert.equal(c.status, 201); assert.equal(c.body.version, 1);
  const id = c.body.id;
  const list = (await call('GET', '/households', { token: 'chris' })).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, H.sample().household.name);
  assert.equal(list[0].stage, H.bind(H.sample()).onboarding().stage);

  const rec = (await call('GET', '/households/' + id, { token: 'chris' })).body;
  rec.state.household.reference = 'ALD-0042';
  const s1 = await call('PUT', '/households/' + id, { token: 'chris', body: { version: 1, state: rec.state } });
  assert.deepEqual(s1.body, { version: 2, changes: 1 });
  assert.equal((await call('PUT', '/households/' + id, { token: 'chris', body: { version: 2, state: rec.state } })).body.changes, 0);

  const stale = await call('PUT', '/households/' + id, { token: 'sam', body: { version: 1, state: H.sample() } });
  assert.equal(stale.status, 409); assert.equal(stale.body.version, 2); assert.equal(stale.body.updatedBy, 'Chris Reviewer');

  const audit = (await call('GET', '/households/' + id + '/audit', { token: 'sam' })).body;
  assert.deepEqual(audit.map(a => [a.user, a.field, a.from, a.to]), [['Chris Reviewer', 'household.reference', H.sample().household.reference || '', 'ALD-0042'], ['Sam Adviser', 'created', '', H.sample().household.name]]);
  assert.equal((await q(`select count(*)::int n from household_versions where household_id = $1`, [id]))[0].n, 2);
  assert.equal((await call('GET', '/households/' + id, { token: 'sam' })).body.state.household.reference, 'ALD-0042');
});

test('unknown fields are dropped before saving', async () => {
  const st = H.sample(); st.household.evil = '<script>'; st.extra = { a: 1 };
  const { id } = (await call('POST', '/households', { token: 'sam', body: { state: st } })).body;
  const saved = (await q(`select state from households where id = $1`, [id]))[0].state;
  assert.equal(saved.household.evil, undefined); assert.equal(saved.extra, undefined);
});

test('one firm cannot see or change another firm’s households', async () => {
  const [h] = await q(`select id from households where firm_id = $1 limit 1`, [F.a]);
  assert.deepEqual((await call('GET', '/households', { token: 'bea' })).body, []);
  assert.equal((await call('GET', '/households/' + h.id, { token: 'bea' })).status, 404);
  assert.equal((await call('GET', '/households/' + h.id + '/audit', { token: 'bea' })).status, 404);
  assert.equal((await call('PUT', '/households/' + h.id, { token: 'bea', body: { version: 2, state: H.sample() } })).status, 404);
  assert.equal((await call('GET', '/households/not-a-uuid', { token: 'sam' })).status, 404);
});

test('records cannot be deleted or rewritten, even with the service role', async () => {
  for (const sql of ['delete from households', 'delete from household_versions', 'update household_versions set saved_by = $1', 'delete from audit_log', `update audit_log set to_value = $1`, 'truncate audit_log'])
    await assert.rejects(q(sql, sql.includes('$1') ? ['x'] : []), /not allowed/, sql);
});

test('browsers have no direct table access through the Supabase API', async () => {
  await pg.exec(`set role authenticated`);
  try {
    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [TOKENS.chris.userId]);
    for (const t of ['households', 'household_versions', 'audit_log', 'firms']) await assert.rejects(pg.query(`select * from ${t}`), /permission denied/, t);
    await assert.rejects(pg.query(`insert into households (firm_id, version, state, created_by, updated_by) values ($1, 1, '{}', 'x', 'x')`, [F.a]), /permission denied/);
    await assert.rejects(pg.query(`select save_household(gen_random_uuid(), $1, 1, '{}', '{}', '[]', gen_random_uuid(), 'x')`, [F.a]), /permission denied/);
    const own = (await pg.query(`select display_name from members`)).rows;
    assert.deepEqual(own, [{ display_name: 'Chris Reviewer' }]);
  } finally { await pg.exec(`reset role`); }
  await pg.exec(`set role anon`);
  try { await assert.rejects(pg.query(`select * from members`), /permission denied/); } finally { await pg.exec(`reset role`); }
});

test('administrators manage their team within their seat limit', async () => {
  assert.equal((await call('GET', '/members', { token: 'chris' })).status, 403);
  assert.equal((await call('GET', '/members', { token: 'sam' })).body.length, 3);
  assert.equal((await call('POST', '/members', { token: 'sam', body: { email: 'bad', name: 'X' } })).status, 400);
  // Alder has 3 seats and 3 active people (sam, chris, nomfa)
  assert.equal((await call('POST', '/members', { token: 'sam', body: { email: 'new@example.co.uk', name: 'New Person' } })).status, 402);
  const off = await call('PATCH', '/members/' + TOKENS.nomfa.userId, { token: 'sam', body: { active: false } });
  assert.equal(off.body.active, false);
  assert.equal((await call('POST', '/members', { token: 'sam', body: { email: 'bea@example.co.uk', name: 'Bea' } })).status, 409);
  const inv = await call('POST', '/members', { token: 'sam', body: { email: 'New@Example.co.uk', name: 'New Person', role: 'adviser' } });
  assert.equal(inv.status, 201); assert.equal(inv.body.email, 'new@example.co.uk');
  assert.equal((await call('PATCH', '/members/' + TOKENS.nomfa.userId, { token: 'sam', body: { active: true } })).status, 402);
  assert.equal((await call('PATCH', '/members/' + TOKENS.sam.userId, { token: 'sam', body: { active: false } })).status, 400);
  assert.equal((await call('PATCH', '/members/' + TOKENS.bea.userId, { token: 'sam', body: { active: false } })).status, 404);

  const chrisOff = await call('PATCH', '/members/' + TOKENS.chris.userId, { token: 'sam', body: { active: false } });
  assert.equal(chrisOff.status, 200);
  assert.equal((await call('GET', '/households', { token: 'chris' })).status, 403, 'a deactivated person is locked out at once');
  await call('PATCH', '/members/' + TOKENS.chris.userId, { token: 'sam', body: { active: true } });
});

test('only the app’s own site may call the API from a browser', async () => {
  const pre = await handle(new Request('http://edge/api/households', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), deps);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  const evil = await call('GET', '/me', { token: 'sam', origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('POST', '/households', { token: 'sam', body: undefined })).status, 415);
});
