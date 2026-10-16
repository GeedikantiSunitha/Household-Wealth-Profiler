// backend/src/auth/sessions.js: server-side sessions in a cookie. Random 256-bit id, stored
// hashed; idle and absolute limits; rotation; revocation; a CSRF token bound to the session.
// Checked here against an in-memory store with a fake clock; the PostgreSQL store is covered by
// session-api.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSessions, sessionSecretFrom, COOKIE_SECURE, COOKIE_PLAIN, TOUCH_MS } = require('../../backend/src/services/auth/sessions.js');

// The slice of the sign-in store that sessions use, in memory
function fakeStore() {
  const sessions = new Map(), users = new Map(), memberOf = new Map();
  const S = {
    users, memberOf, sessions,
    findUser: async id => users.get(id) || null,
    memberships: async userId => (memberOf.get(userId) || []),
    createSession: async ({ idHash, userId, firmId = null, stage, expiresAt, ip = '', userAgent = '', at }) => { const row = { id_hash: idHash, user_id: userId, firm_id: firmId, stage, created_at: at, last_seen_at: at, expires_at: expiresAt, ip, user_agent: userAgent, revoked_at: null }; sessions.set(idHash, row); return row; },
    findSession: async idHash => sessions.get(idHash) || null,
    touchSession: async (idHash, at) => { sessions.get(idHash).last_seen_at = at; },
    revokeSession: async (idHash, at) => { const s = sessions.get(idHash); if (s && !s.revoked_at) s.revoked_at = at; },
    rotateSession: async (oldHash, { idHash, stage, firmId, at }) => { const o = sessions.get(oldHash); o.revoked_at = at; const row = { ...o, id_hash: idHash, stage: stage ?? o.stage, firm_id: firmId === undefined ? o.firm_id : firmId, created_at: at, last_seen_at: at, revoked_at: null }; sessions.set(idHash, row); return row; },
    revokeAllSessions: async (userId, { except = null, at }) => { let n = 0; for (const s of sessions.values()) if (s.user_id === userId && !s.revoked_at && s.id_hash !== except) { s.revoked_at = at; n++; } return n; },
  };
  return S;
}
const UID = '11111111-1111-4111-8111-111111111111', FIRM = 'f1a00000-0000-4000-8000-000000000001';
const req = (cookie, headers = {}) => ({ headers: { ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: '10.0.0.1' } });
const cookieOf = setCookie => setCookie.split(';')[0];

function setup({ secure = true } = {}) {
  const store = fakeStore();
  store.users.set(UID, { id: UID, email: 'sam@example.com', name: 'Sam', active: true });
  store.memberOf.set(UID, [{ firmId: FIRM, firmName: 'Default firm', role: 'adviser' }]);
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const sessions = createSessions({ store, secret: crypto.randomBytes(32), idleMs: 30 * 60e3, absoluteMs: 12 * 3600e3, secure, now: () => clock.t });
  return { store, clock, sessions };
}

test('the session secret comes from DATA_KEY by derivation with its own label; without a key it is random per process', () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(sessionSecretFrom(key), sessionSecretFrom(key));
  assert.notDeepEqual(sessionSecretFrom(key), key, 'never the key itself');
  assert.notDeepEqual(sessionSecretFrom(key), Buffer.from(crypto.hkdfSync('sha256', key, '', 'hwp record key v1', 32)), 'a label of its own');
  assert.notDeepEqual(sessionSecretFrom(null), sessionSecretFrom(null));
});

test('the cookie: __Host- prefix, Secure, HttpOnly, SameSite=Strict, Path=/ in production; a plain name without Secure in development', async () => {
  const { sessions } = setup();
  const s = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  assert.equal(COOKIE_SECURE, '__Host-hwp_session'); assert.equal(COOKIE_PLAIN, 'hwp_session');
  assert.match(s.cookie, /^__Host-hwp_session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/, s.cookie);
  assert.match(sessions.clearCookie(), /^__Host-hwp_session=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  const dev = setup({ secure: false });
  assert.match((await dev.sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' })).cookie, /^hwp_session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
});

test('the id in the cookie is random and stored only as a hash; the CSRF token is bound to the session', async () => {
  const { store, sessions } = setup();
  const a = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  const b = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  assert.notEqual(a.id, b.id);
  assert.ok(!store.sessions.has(a.id), 'the raw id is not a key in the store');
  assert.ok(store.sessions.has(crypto.createHash('sha256').update(a.id).digest('hex')), 'its hash is');
  assert.match(a.csrf, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a.csrf, b.csrf);
  const r = await sessions.resolve(req(cookieOf(a.cookie)));
  assert.equal(r.csrf, a.csrf, 'the same token every time for this session');
  assert.equal(r.user.email, 'sam@example.com'); assert.equal(r.session.stage, 'full'); assert.equal(r.session.firm_id, FIRM); assert.equal(r.role, 'adviser');
});

test('no cookie, an unknown id, a malformed cookie or a revoked session resolve to nothing', async () => {
  const { sessions } = setup();
  const s = await sessions.issue({ userId: UID, stage: 'password' });
  assert.equal(await sessions.resolve(req(null)), null);
  assert.equal(await sessions.resolve(req('other=1')), null);
  assert.equal(await sessions.resolve(req('__Host-hwp_session=' + 'x'.repeat(43))), null);
  assert.equal(await sessions.resolve(req('__Host-hwp_session=not%20valid')), null);
  assert.ok(await sessions.resolve(req(cookieOf(s.cookie))));
  await sessions.revoke(await sessions.resolve(req(cookieOf(s.cookie))));
  assert.equal(await sessions.resolve(req(cookieOf(s.cookie))), null, 'revoked');
});

test('idle limit: a session not seen for 30 minutes ends; activity is recorded at most once a minute', async () => {
  const { store, clock, sessions } = setup();
  const s = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  const hash = crypto.createHash('sha256').update(s.id).digest('hex');
  clock.t += 30e3; assert.ok(await sessions.resolve(req(cookieOf(s.cookie))));
  assert.equal(new Date(store.sessions.get(hash).last_seen_at).getTime(), clock.t - 30e3, 'not touched within a minute');
  clock.t += TOUCH_MS; assert.ok(await sessions.resolve(req(cookieOf(s.cookie))));
  assert.equal(new Date(store.sessions.get(hash).last_seen_at).getTime(), clock.t, 'touched after a minute');
  clock.t += 30 * 60e3 - 1; assert.ok(await sessions.resolve(req(cookieOf(s.cookie))), 'just inside the idle limit');
  clock.t += 30 * 60e3 + 1; assert.equal(await sessions.resolve(req(cookieOf(s.cookie))), null, 'idle too long');
  assert.ok(store.sessions.get(hash).revoked_at, 'and recorded as ended');
});

test('absolute limit: 12 hours from sign-in however active; rotation keeps the original limit', async () => {
  const { clock, sessions } = setup();
  const s = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  let cookie = cookieOf(s.cookie);
  for (let i = 0; i < 23; i++) { clock.t += 30 * 60e3 - 1; assert.ok(await sessions.resolve(req(cookie)), 'active every half hour: ' + i); }
  const r = await sessions.resolve(req(cookie));
  const rotated = await sessions.rotate(r.session, { stage: 'full' });
  assert.match(rotated.cookie, /Max-Age=\d+;/); assert.ok(+/Max-Age=(\d+)/.exec(rotated.cookie)[1] < 3600, 'the rotated cookie carries the remaining time, not a fresh 12 hours');
  cookie = cookieOf(rotated.cookie);
  clock.t += 2 * 3600e3;
  assert.equal(await sessions.resolve(req(cookie)), null, 'past the absolute limit');
});

test('rotation: the old id stops working at once; stage and firm can change; the CSRF token changes', async () => {
  const { sessions } = setup();
  const s = await sessions.issue({ userId: UID, stage: 'password' });
  const r = await sessions.resolve(req(cookieOf(s.cookie)));
  const n = await sessions.rotate(r.session, { stage: 'full', firmId: FIRM });
  assert.equal(await sessions.resolve(req(cookieOf(s.cookie))), null, 'the old id is dead');
  const r2 = await sessions.resolve(req(cookieOf(n.cookie)));
  assert.equal(r2.session.stage, 'full'); assert.equal(r2.session.firm_id, FIRM); assert.notEqual(r2.csrf, r.csrf);
});

test('revoke all: every session of the user ends, except the one kept; a deactivated account or a lost membership ends the session on the next request', async () => {
  const { store, clock, sessions } = setup();
  const a = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' }), b = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' }), c = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  const ra = await sessions.resolve(req(cookieOf(a.cookie)));
  assert.equal(await sessions.revokeAll(UID, { except: ra.session }), 2);
  assert.ok(await sessions.resolve(req(cookieOf(a.cookie)))); assert.equal(await sessions.resolve(req(cookieOf(b.cookie))), null); assert.equal(await sessions.resolve(req(cookieOf(c.cookie))), null);
  store.memberOf.set(UID, [{ firmId: FIRM, firmName: 'Default firm', role: 'adviser', active: false }].filter(m => m.active));
  assert.equal(await sessions.resolve(req(cookieOf(a.cookie))), null, 'the firm membership is gone');
  store.memberOf.set(UID, [{ firmId: FIRM, firmName: 'Default firm', role: 'adviser' }]);
  const d = await sessions.issue({ userId: UID, firmId: FIRM, stage: 'full' });
  assert.ok(await sessions.resolve(req(cookieOf(d.cookie))));
  store.users.get(UID).active = false; clock.t += 1000;
  assert.equal(await sessions.resolve(req(cookieOf(d.cookie))), null, 'deactivated: ended at the next request, not the next sign-in');
});
