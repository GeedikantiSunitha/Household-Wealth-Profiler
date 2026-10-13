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
   POST enrol [{password}]          a new authenticator secret (base32 and otpauth URI), shown once and
                                    kept sealed as pending; at a password-stage session when the account
                                    has none, or at a full session with the current password
   POST enrol/confirm {code}        the first code from the app confirms it: ten recovery codes (shown
                                    once, stored hashed, replacing any old set); the session becomes full
                                    (the only firm chosen, else next 'firm'); at a re-enrolment every
                                    other session ends
   POST totp {code}                 the second step: current step or one either side, never a step
                                    already accepted; a wrong code counts towards the progressive delay
   POST recovery {code}             signs in with a recovery code (once): full session, every other
                                    session ends, the authenticator no longer counts until re-enrolled
                                    (next 'enrol'), the user is warned (notify.recoveryUsed)
   POST password {current, next}    checks the current password, the policy and the breach list; other
                                    sessions end and this one is rotated
   Every outcome is an auth event. The per-address limiter counts attempts on sign-in, codes and
   recovery codes. Secrets are sealed with DATA_KEY (rotate-key re-seals them). */
'use strict';
const crypto = require('crypto');
const { verifyPassword, dummyVerify, hashPassword, checkPolicy, breachedCount } = require('../auth/password.js');
const { ipOf } = require('../auth/limiter.js');
const { generateSecret, base32Encode, base32Decode, otpauthUri, verifyCode, newRecoveryCodes, normaliseRecoveryCode } = require('../auth/totp.js');
const { ID_RE } = require('../repositories/ids.js');

const WARN_AT = 5;
const refuse = (status, error, code) => Object.assign(new Error(error), { status, code });
const BAD_CREDENTIALS = () => refuse(401, 'Email or password is not right', 'bad_credentials');
const SECOND_STEP = () => refuse(401, 'Finish signing in: enter the code from your authenticator app', 'second_step_required');

function createAuthRoutes({ authStore, sessions, limiter, notify = {}, clientIpHeader = '', now = Date.now, sealer = { seal: t => t, open: t => t }, issuer = 'Household Wealth Profiler', breached = {} }) {
  const event = (ctx, userId, ev, outcome, detail = '') => authStore.event({ userId, email: ctx.email || '', event: ev, outcome, ip: ctx.ip, userAgent: ctx.userAgent, detail });
  const BAD_CODE = (msg = 'That code is not right') => refuse(401, msg, 'bad_code');
  const codeHash = code => crypto.createHash('sha256').update(code).digest('hex');

  // The second step is done: a full session, in the only firm or with a firm still to choose
  async function finish(ctx, user, { next = null } = {}) {
    const firms = await authStore.memberships(user.id);
    const firm = firms.length === 1 ? firms[0] : null;
    const r = await sessions.rotate(ctx.auth.session, { stage: 'full', firmId: firm ? firm.firmId : null });
    return { reply: { stage: 'full', next: next || (firm ? null : 'firm'), firmId: firm ? firm.firmId : null, firmName: firm ? firm.firmName : null, role: firm ? firm.role : null, csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
  }

  async function totp(ctx) {
    if (ctx.auth.stage === 'full') throw refuse(400, 'You are already signed in', 'already_signed_in');
    const user = await authStore.findUser(ctx.auth.userId);
    if (!user.totp_secret || !user.totp_confirmed_at || user.reenrol) throw refuse(400, 'Set up your authenticator app first', 'enrol_required');
    if (user.not_before && new Date(user.not_before).getTime() > now()) { await event(ctx, user.id, 'totp', 'slowed'); throw BAD_CODE(); }
    const v = verifyCode(base32Decode(sealer.open(user.totp_secret)), ctx.body && ctx.body.code, { nowMs: now(), lastStep: Number(user.totp_last_step) });
    if (!v.ok) {
      const replay = verifyCode(base32Decode(sealer.open(user.totp_secret)), ctx.body && ctx.body.code, { nowMs: now(), lastStep: 0 }).ok;
      await authStore.recordFailure(user.id);
      await event(ctx, user.id, 'totp', replay ? 'replay' : 'bad_code');
      throw BAD_CODE();
    }
    await authStore.setTotpStep(user.id, v.step);
    await authStore.recordSuccess(user.id);
    await event(ctx, user.id, 'totp', 'ok');
    return finish(ctx, user);
  }

  async function enrol(ctx) {
    const user = await authStore.findUser(ctx.auth.userId);
    if (ctx.auth.stage === 'full') {
      const password = ctx.body && ctx.body.password;
      if (typeof password !== 'string' || !(await verifyPassword(user.password_hash, password))) { await event(ctx, user.id, 'enrol', 'bad_password'); throw refuse(401, 'The current password is not right', 'bad_credentials'); }
    } else if (user.totp_secret && user.totp_confirmed_at && !user.reenrol) throw refuse(400, 'Enter the code from your authenticator app', 'second_step_required');
    const secret = generateSecret();
    await authStore.setPendingTotp(user.id, sealer.seal(base32Encode(secret)));
    await event(ctx, user.id, 'enrol', 'started');
    return { reply: { secret: base32Encode(secret), uri: otpauthUri(secret, user.email, issuer) } };
  }

  async function confirmEnrol(ctx) {
    const user = await authStore.findUser(ctx.auth.userId);
    if (!user.totp_pending) throw refuse(400, 'Start by setting up your authenticator app', 'enrol_required');
    const pending = user.totp_pending;
    const v = verifyCode(base32Decode(sealer.open(pending)), ctx.body && ctx.body.code, { nowMs: now(), lastStep: 0 });
    if (!v.ok) { await event(ctx, user.id, 'enrol', 'bad_code'); throw refuse(400, 'That code is not right. Check the time on your phone and try the next code.', 'bad_code'); }
    const codes = newRecoveryCodes();
    await authStore.confirmTotp(user.id, { sealed: pending, step: v.step });
    await authStore.replaceRecoveryCodes(user.id, codes.map(codeHash));
    await event(ctx, user.id, 'enrol', 'confirmed');
    if (ctx.auth.stage === 'full') {
      await sessions.revokeAll(user.id, { except: ctx.auth.session });
      const r = await sessions.rotate(ctx.auth.session, {});
      return { reply: { stage: 'full', next: null, firmId: ctx.auth.firmId, firmName: ctx.auth.firmName || null, role: ctx.auth.role || null, recoveryCodes: codes, csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
    }
    const done = await finish(ctx, user);
    done.reply.recoveryCodes = codes;
    return done;
  }

  async function recovery(ctx) {
    if (ctx.auth.stage === 'full') throw refuse(400, 'You are already signed in', 'already_signed_in');
    const user = await authStore.findUser(ctx.auth.userId);
    const code = normaliseRecoveryCode(ctx.body && ctx.body.code);
    const wanted = Buffer.from(codeHash(code || '-'));
    let hit = null;
    for (const r of await authStore.unusedRecoveryCodes(user.id)) { const h = Buffer.from(r.code_hash); if (h.length === wanted.length && crypto.timingSafeEqual(h, wanted) && !hit) hit = r; }
    if (!hit) { await authStore.recordFailure(user.id); await event(ctx, user.id, 'recovery', 'bad_code'); throw BAD_CODE('That recovery code is not right'); }
    await authStore.useRecoveryCode(hit.id);
    await authStore.clearTotp(user.id);
    await authStore.recordSuccess(user.id);
    await sessions.revokeAll(user.id, { except: ctx.auth.session });
    await event(ctx, user.id, 'recovery', 'ok');
    if (notify.recoveryUsed) await notify.recoveryUsed(user, { ip: ctx.ip });
    return finish(ctx, user, { next: 'enrol' });
  }

  async function changePassword(ctx) {
    const user = await authStore.findUser(ctx.auth.userId);
    const { current, next } = ctx.body || {};
    if (typeof current !== 'string' || typeof next !== 'string') throw refuse(400, 'The current and the new password are required', 'bad_request');
    if (!(await verifyPassword(user.password_hash, current))) { await event(ctx, user.id, 'password_change', 'bad_password'); throw refuse(401, 'The current password is not right', 'bad_credentials'); }
    const problem = checkPolicy(next);
    if (problem) throw refuse(400, problem, 'weak_password');
    const count = await breachedCount(next, breached);
    if (count) { await event(ctx, user.id, 'password_change', 'breached'); throw refuse(400, 'That password has appeared in a data breach. Choose a different one.', 'breached_password'); }
    await authStore.setPassword(user.id, await hashPassword(next));
    await sessions.revokeAll(user.id, { except: ctx.auth.session });
    const r = await sessions.rotate(ctx.auth.session, {});
    await event(ctx, user.id, 'password_change', 'ok', count === null ? 'breach check skipped' : '');
    return { reply: { ok: true, csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
  }

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
    'POST /api/auth/totp': { stage: 'any', limited: true, fn: totp },
    'POST /api/auth/enrol': { stage: 'any', fn: enrol },
    'POST /api/auth/enrol/confirm': { stage: 'any', limited: true, fn: confirmEnrol },
    'POST /api/auth/recovery': { stage: 'any', limited: true, fn: recovery },
    'POST /api/auth/password': { stage: 'full', fn: changePassword },
  };
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
