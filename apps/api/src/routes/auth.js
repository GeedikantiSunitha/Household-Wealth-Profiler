/* The app's own sign-in (Phase 2): the routes under /api/auth/. Reached before the sign-in gate,
   after the same-site and JSON checks; each route says what it needs:
     none   no session (sign-in itself)
     any    a session at any stage (sign-out, and in 2.5 the second step)
     full   a session whose second step is done; writes carry the session's CSRF token
   POST sign-in {email, password}   401 bad_credentials for a wrong password, an unknown email, a
                                    deactivated account, one without a password or without a firm,
                                    or one in its progressive delay: the same reply for all, so
                                    nothing says which accounts exist (the auth event does). Each
                                    failure runs a real or dummy scrypt, so timing says nothing
                                    either. Success: a 'password' stage session in the cookie, the
                                    CSRF token and the next step ('totp', or 'enrol' when the
                                    account has no authenticator yet). An earlier session ends.
     On the fifth consecutive failure the account holder is warned (notify.lockoutWarning) once.
   POST sign-out                    ends the session; the cookie is cleared
   POST sign-out-all                ends every session of the account
   GET  firms                       the firms the account belongs to
   POST firm {firmId}               the session's firm; the session id is rotated
   Every outcome is an auth event. The per-address limiter counts attempts on sign-in. */
'use strict';
const { verifyPassword, dummyVerify } = require('../auth/password.js');
const { ipOf } = require('../auth/limiter.js');
const { ID_RE } = require('../repositories/ids.js');

const WARN_AT = 5;
const refuse = (status, error, code) => Object.assign(new Error(error), { status, code });
const BAD_CREDENTIALS = () => refuse(401, 'Email or password is not right', 'bad_credentials');
const SECOND_STEP = () => refuse(401, 'Finish signing in: enter the code from your authenticator app', 'second_step_required');

function createAuthRoutes({ authStore, sessions, limiter, notify = {}, clientIpHeader = '', now = Date.now }) {
  const event = (ctx, userId, ev, outcome, detail = '') => authStore.event({ userId, email: ctx.email || '', event: ev, outcome, ip: ctx.ip, userAgent: ctx.userAgent, detail });

  async function signIn(ctx) {
    const { email, password } = ctx.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password || email.length > 254 || password.length > 1000) throw refuse(400, 'Email and password are required', 'bad_request');
    ctx.email = email;
    const user = await authStore.findUserByEmail(email);
    const fail = async (outcome, userId = null, dummy = true) => { if (dummy) await dummyVerify(password); await event(ctx, userId, 'sign_in', outcome); throw BAD_CREDENTIALS(); };
    if (!user) return fail('unknown');
    if (!user.active) return fail('inactive', user.id);
    if (!user.password_hash) return fail('no_password', user.id);
    if (!(await authStore.memberships(user.id)).length) return fail('no_firm', user.id);
    if (user.not_before && new Date(user.not_before).getTime() > now()) return fail('slowed', user.id);
    if (!(await verifyPassword(user.password_hash, password))) {
      const { failures } = await authStore.recordFailure(user.id);
      if (failures === WARN_AT && notify.lockoutWarning) {
        await notify.lockoutWarning(user, { failures, ip: ctx.ip });
        await event(ctx, user.id, 'lockout_notice', 'sent', `${failures} failures`);
      }
      return fail('bad_password', user.id, false);
    }
    await authStore.recordSuccess(user.id);
    if (ctx.auth && ctx.auth.session) await sessions.revoke(ctx.auth);
    const s = await sessions.issue({ userId: user.id, stage: 'password', ip: ctx.ip, userAgent: ctx.userAgent });
    await event(ctx, user.id, 'sign_in', 'ok', 'password');
    return { reply: { stage: 'password', next: user.totp_confirmed_at && !user.reenrol ? 'totp' : 'enrol', csrf: s.csrf }, headers: { 'Set-Cookie': s.cookie } };
  }

  async function signOut(ctx) {
    const cookie = await sessions.revoke(ctx.auth);
    await event(ctx, ctx.auth.userId, 'sign_out', 'ok');
    return { reply: { ok: true }, headers: { 'Set-Cookie': cookie } };
  }

  async function signOutAll(ctx) {
    const ended = await sessions.revokeAll(ctx.auth.userId, {});
    await event(ctx, ctx.auth.userId, 'sign_out_all', 'ok', `${ended} session(s)`);
    return { reply: { ok: true, ended }, headers: { 'Set-Cookie': sessions.clearCookie() } };
  }

  const firms = async ctx => ({ reply: await authStore.memberships(ctx.auth.userId) });

  async function switchFirm(ctx) {
    const firmId = ctx.body && ctx.body.firmId;
    if (typeof firmId !== 'string' || !ID_RE.test(firmId)) throw refuse(400, 'Choose a firm', 'bad_request');
    const m = (await authStore.memberships(ctx.auth.userId)).find(x => x.firmId === firmId);
    if (!m) throw refuse(403, 'You are not a member of that firm', 'forbidden');
    const r = await sessions.rotate(ctx.auth.session, { firmId });
    await event(ctx, ctx.auth.userId, 'firm_switch', 'ok', firmId);
    return { reply: { firmId, firmName: m.firmName, role: m.role, csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
  }

  const ROUTES = {
    'POST /api/auth/sign-in': { stage: 'none', limited: true, fn: signIn },
    'POST /api/auth/sign-out': { stage: 'any', fn: signOut },
    'POST /api/auth/sign-out-all': { stage: 'full', fn: signOutAll },
    'GET /api/auth/firms': { stage: 'full', fn: firms },
    'POST /api/auth/firm': { stage: 'full', fn: switchFirm },
  };
  // 2.5 adds routes here (second step, enrolment, recovery, password change)
  const add = (key, route) => { ROUTES[key] = route; };

  // true when the request was one of these routes (and has been answered)
  async function handle({ req, res, p, auth, send, readBody }) {
    if (!p.startsWith('/api/auth/')) return false;
    const route = ROUTES[`${req.method} ${p}`];
    if (!route) { send(res, 404, { error: 'Not found' }); return true; }
    if (auth && auth.locked) { send(res, 429, { error: 'Too many failed sign-ins. Try again in 15 minutes.', code: 'locked_out' }); return true; }
    const session = auth && auth.session ? auth : null;
    if (route.stage !== 'none') {
      if (!session) { send(res, 401, { error: 'Sign in required', code: 'sign_in_required' }); return true; }
      if (route.stage === 'full' && session.stage !== 'full') { const e = SECOND_STEP(); send(res, e.status, { error: e.message, code: e.code }); return true; }
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) { send(res, 403, { error: 'Request refused: the sign-in token is missing or stale. Reload the page.', code: 'csrf' }); return true; }
    }
    const ip = ipOf(req, clientIpHeader);
    if (route.limited) {
      const l = limiter.hit(ip);
      if (!l.allowed) { send(res, 429, { error: 'Too many attempts from this address. Try again in 15 minutes.', code: 'too_many_attempts' }, { 'Retry-After': String(l.retryAfter) }); return true; }
    }
    const ctx = { ip, userAgent: req.headers['user-agent'] || '', auth: session || auth, email: session ? session.email : '', body: req.method === 'GET' ? {} : await readBody(req) };
    try {
      const { status = 200, reply, headers = {} } = await route.fn(ctx);
      send(res, status, reply, headers);
    } catch (e) {
      if (!e.status) throw e;
      send(res, e.status, { error: e.message, code: e.code, ...(e.errors ? { errors: e.errors } : {}) });
    }
    return true;
  }

  return { handle, add, routes: ROUTES };
}

module.exports = { createAuthRoutes, WARN_AT };
