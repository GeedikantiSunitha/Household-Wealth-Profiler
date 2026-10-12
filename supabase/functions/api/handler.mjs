// API for the Supabase edition. Same routes and replies as server.js, plus team management.
// Platform-neutral: index.ts wires it to Supabase on Deno; the tests wire it to PGlite on Node.
//   deps.HWP      core.js
//   deps.verify   async (token) -> { userId, email, aal } | null
//   deps.db       data access (see index.ts / test/supabase/supabase.test.js)
//   deps.origins  allowed browser origins for CORS
//   deps.requireMfa  refuse sessions that have not passed a second factor
//   deps.inviteRedirect  where invite emails send people to choose a password

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 2 * 1024 * 1024;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function cors(req, origins) {
  const o = req.headers.get('origin');
  const h = { 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
  if (o && origins.includes(o)) h['Access-Control-Allow-Origin'] = o;
  return h;
}
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function readBody(req) {
  if (!(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Send JSON');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw new HttpError(400, 'Invalid JSON'); }
}

export function summarise(HWP, state) {
  const s = HWP.normalise(state);
  let stage = '', rating = '', nextReview = '', blockers = 0, due = '', overdue = 0;
  try { const E = HWP.bind(s); const O = E.onboarding(E.compute()); stage = O.stage; rating = O.rating; nextReview = O.nextReview || ''; blockers = O.blockerCount; const R = E.reviews(O); due = R.nextDue; overdue = R.overdue; } catch (e) { stage = 'Error'; }
  return { name: s.household.name || '', reference: s.household.reference || '', stage, rating, nextReview, blockers, due, overdue, tasks: HWP.openTasks(s) };
}
const listRow = r => ({ id: r.id, name: r.name, reference: r.reference, stage: r.stage, rating: r.rating, nextReview: r.next_review, blockers: r.blockers, due: r.review_due, overdue: r.review_overdue, tasks: r.open_tasks || [], version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by });
const memberRow = m => ({ userId: m.user_id, email: m.email, name: m.display_name, role: m.role, active: m.active, createdAt: m.created_at });

export async function handle(req, deps) {
  const headers = cors(req, deps.origins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    return await route(req, deps, headers);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra }, headers);
    console.error(new Date().toISOString(), req.method, req.url, e);
    return json(500, { error: 'Server error' }, headers);
  }
}

async function route(req, { HWP, verify, db, requireMfa, inviteRedirect }, headers) {
  const m0 = /^(?:\/functions\/v1)?\/api(\/.*)?$/.exec(new URL(req.url).pathname);
  const p = m0 ? (m0[1] || '/') : null;
  if (p === null) throw new HttpError(404, 'Not found');
  if (p === '/healthz') return json(200, { ok: true }, headers);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = token ? await verify(token) : null;
  if (!claims) throw new HttpError(401, 'Sign in required');
  if (requireMfa && claims.aal !== 'aal2') throw new HttpError(403, 'Two-step verification required', { code: 'mfa_required' });
  const me = await db.member(claims.userId);
  if (!me || !me.active) throw new HttpError(403, 'Your account is not active for any firm. Ask your firm administrator.');
  if (me.firm_status !== 'active') throw new HttpError(403, 'Your firm’s subscription is suspended. Contact support.');
  const user = me.display_name, firm = me.firm_id, admin = me.role === 'admin';
  const ok = (body, status = 200) => json(status, body, headers);
  const M = req.method;

  if (p === '/me' && M === 'GET') return ok({ user, email: me.email, role: me.role, firm: me.firm_name, seats: me.seats, encrypted: true });

  /* ---------- firm settings: details, team and providers ---------- */
  if (p === '/firm' && M === 'GET') { const f = await db.getFirm(firm); return ok({ version: f.settings_version, settings: HWP.firmNormalise(f.settings && f.settings.firm ? f.settings : null), updatedAt: f.settings_updated_at, updatedBy: f.settings_updated_by }); }
  if (p === '/firm/audit' && M === 'GET') return ok((await db.firmAudit(firm, 5000)).map(a => ({ ts: a.ts, user: a.user_name, field: a.field, from: a.from_value, to: a.to_value, version: a.version })));
  if (p === '/firm' && M === 'PUT') {
    if (!admin) throw new HttpError(403, 'Only a firm administrator can change firm settings');
    const body = await readBody(req);
    const f = await db.getFirm(firm);
    const expected = +body.version;
    if (expected !== f.settings_version) throw new HttpError(409, 'Firm settings were changed by someone else', { version: f.settings_version, updatedBy: f.settings_updated_by, updatedAt: f.settings_updated_at });
    const settings = HWP.firmNormalise(body.settings);
    const changes = HWP.firmDiff(f.settings && f.settings.firm ? f.settings : HWP.firmBlank(), settings).map(c => ({ field: c.field, from: String(c.from ?? ''), to: String(c.to ?? '') }));
    const r = await db.saveFirm({ firm, expected, settings, changes, userId: claims.userId, user });
    if (r.status === 409) throw new HttpError(409, 'Firm settings were changed by someone else', { version: r.version, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
    return ok({ version: r.version, changes: r.changes });
  }

  if (p === '/households' && M === 'GET') return ok((await db.listHouseholds(firm)).map(listRow));
  if (p === '/households' && M === 'POST') {
    const body = await readBody(req);
    const state = HWP.normalise(body.state); delete state.audit;
    return ok(await db.createHousehold({ firm, state, summary: summarise(HWP, state), userId: claims.userId, user }), 201);
  }
  const mh = /^\/households\/([^/]+)(\/audit)?$/.exec(p);
  if (mh) {
    const id = mh[1];
    if (!ID_RE.test(id)) throw new HttpError(404, 'Not found');
    const rec = await db.getHousehold(id, firm);
    if (!rec) throw new HttpError(404, 'Not found');
    if (mh[2] && M === 'GET') return ok((await db.audit(id, firm, 5000)).map(a => ({ ts: a.ts, user: a.user_name, field: a.field, from: a.from_value, to: a.to_value, version: a.version })));
    if (!mh[2] && M === 'GET') return ok({ id: rec.id, version: rec.version, state: rec.state, createdAt: rec.created_at, createdBy: rec.created_by, updatedAt: rec.updated_at, updatedBy: rec.updated_by });
    if (!mh[2] && M === 'PUT') {
      const body = await readBody(req);
      const expected = +body.version;
      if (expected !== rec.version) throw new HttpError(409, 'This household was changed by someone else', { version: rec.version, updatedBy: rec.updated_by, updatedAt: rec.updated_at });
      const state = HWP.normalise(body.state); delete state.audit;
      const changes = HWP.diff(rec.state, state).map(c => ({ field: c.field, from: String(c.from ?? ''), to: String(c.to ?? '') }));
      const r = await db.saveHousehold({ id, firm, expected, state, summary: summarise(HWP, state), changes, userId: claims.userId, user });
      if (r.status === 409) throw new HttpError(409, 'This household was changed by someone else', { version: r.version, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
      if (r.status !== 200) throw new HttpError(r.status, 'Not found');
      return ok({ version: r.version, changes: r.changes });
    }
  }

  /* ---------- team (firm administrators) ---------- */
  if (p === '/members' || p.startsWith('/members/')) {
    if (!admin) throw new HttpError(403, 'Only a firm administrator can manage the team');
    if (p === '/members' && M === 'GET') return ok((await db.listMembers(firm)).map(memberRow));
    if (p === '/members' && M === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), role = b.role === 'admin' ? 'admin' : 'adviser';
      if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address');
      if (!name || name.length > 100) throw new HttpError(400, 'Enter the person’s name (up to 100 characters)');
      const active = (await db.listMembers(firm)).filter(x => x.active).length;
      if (active >= me.seats) throw new HttpError(402, `All ${me.seats} seats are in use. Deactivate someone or add seats to your plan.`);
      const r = await db.inviteMember({ firm, email, name, role, redirectTo: inviteRedirect });
      if (r.conflict) throw new HttpError(409, 'That email address already belongs to a user. Each person can belong to one firm.');
      return ok(memberRow(r.member), 201);
    }
    const mm = /^\/members\/([^/]+)$/.exec(p);
    if (mm && M === 'PATCH') {
      const uid = mm[1];
      if (!ID_RE.test(uid)) throw new HttpError(404, 'Not found');
      if (uid === claims.userId) throw new HttpError(400, 'You cannot change your own access. Ask another administrator.');
      const b = await readBody(req);
      const patch = {};
      if (typeof b.active === 'boolean') patch.active = b.active;
      if (b.role === 'admin' || b.role === 'adviser') patch.role = b.role;
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
      if (patch.active) {
        const list = await db.listMembers(firm);
        const target = list.find(x => x.user_id === uid);
        if (target && !target.active && list.filter(x => x.active).length >= me.seats) throw new HttpError(402, `All ${me.seats} seats are in use.`);
      }
      const row = await db.updateMember(firm, uid, patch);
      if (!row) throw new HttpError(404, 'Not found');
      return ok(memberRow(row));
    }
  }
  throw new HttpError(404, 'Not found');
}
