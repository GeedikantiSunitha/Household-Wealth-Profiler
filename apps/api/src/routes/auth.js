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
   GET  firms                       the firms the account belongs to (accepted memberships, with their roles)
   POST firm {firmId}               the session's firm; the session id is rotated
   GET  invitations                 invitations to a firm that this account has not answered (an existing account
                                    invited by another firm's administrator); each waits for the person's own answer
   POST invitations/accept {firmId} / invitations/decline {firmId}
                                    the person's answer. Nothing about a firm is open to them until they accept; at
                                    sign-in, pending invitations come before the choice of firm. Only this account's
                                    own pending invitation can be answered here: no route creates or approves one.
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
   POST forgot {email}              always 200; a known, active account gets a reset link by email
                                    (30 minutes, single use, token in the fragment)
   POST reset {token, password}     sets the password through the link; every session ends
   POST invite {token, password}    a new account chooses its password through the invitation link
                                    (24 hours, single use); then it signs in and enrols as usual
   POST request-access {name, email, firm, note}  stored for the operator, who is told by email;
                                    always 200; fields capped; a few per address per hour
   GET  state                       for a half-finished session after a reload: stage, next, csrf
   Every outcome is an auth event. The per-address limiter counts attempts on sign-in, codes,
   recovery codes and links. Secrets are sealed with DATA_KEY (rotate-key re-seals them). */
'use strict';
const crypto = require('crypto');
const { verifyPassword, dummyVerify, hashPassword, checkPolicy, breachedCount } = require('../auth/password.js');
const { ipOf } = require('../middleware/rate-limit.js');
const { requireStage, limited } = require('../middleware/guards.js');
const { generateSecret, base32Encode, base32Decode, otpauthUri, verifyCode, newRecoveryCodes, normaliseRecoveryCode } = require('../auth/totp.js');
const { ID_RE } = require('../repositories/ids.js');

const WARN_AT = 5;
const RESET_TTL_MS = 30 * 60e3;
const REQUEST_LIMIT = Object.freeze({ max: 3, windowMs: 3600e3 });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const refuse = (status, error, code) => Object.assign(new Error(error), { status, code });
const BAD_CREDENTIALS = () => refuse(401, 'Email or password is not right', 'bad_credentials');
const SECOND_STEP = () => refuse(401, 'Finish signing in: enter the code from your authenticator app', 'second_step_required');

function createAuthRoutes({ authStore, sessions, limiter, notify = {}, clientIpHeader = '', now = Date.now, sealer = { seal: t => t, open: t => t }, issuer = 'Household Wealth Profiler', breached = {}, requestLimiter = null }) {
  const { createLimiter } = require('../middleware/rate-limit.js');
  requestLimiter = requestLimiter || createLimiter({ ...REQUEST_LIMIT, now });
  const event = (ctx, userId, ev, outcome, detail = '') => authStore.event({ userId, email: ctx.email || '', event: ev, outcome, ip: ctx.ip, userAgent: ctx.userAgent, detail });
  const BAD_CODE = (msg = 'That code is not right') => refuse(401, msg, 'bad_code');
  const codeHash = code => crypto.createHash('sha256').update(code).digest('hex');

  // The second step is done: a full session, in the only firm or with a firm still to choose
  async function finish(ctx, user, { next = null } = {}) {
    const firms = await authStore.memberships(user.id);
    const pending = await authStore.pendingInvitations(user.id);
    // With an invitation waiting, the person answers it before anything is chosen for them
    const firm = !pending.length && firms.length === 1 ? firms[0] : null;
    const r = await sessions.rotate(ctx.auth.session, { stage: 'full', firmId: firm ? firm.firmId : null });
    return { reply: { stage: 'full', next: next || (pending.length ? 'invitations' : firm ? null : 'firm'), firmId: firm ? firm.firmId : null, firmName: firm ? firm.firmName : null, role: firm ? firm.role : null, roles: firm ? firm.roles : null,
      ...(pending.length ? { invitations: pending } : {}), csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
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
    if (!(await authStore.memberships(user.id)).length && !(await authStore.pendingInvitations(user.id)).length) return fail('no_firm', user.id);
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
    return { reply: { firmId, firmName: m.firmName, role: m.role, roles: m.roles, csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
  }

  const invitations = async ctx => ({ reply: await authStore.pendingInvitations(ctx.auth.userId) });

  // The person's own answer to an invitation. When none is left to answer, they carry on into their only firm, or choose.
  async function answerInvitation(ctx, accept) {
    const firmId = ctx.body && ctx.body.firmId;
    if (typeof firmId !== 'string' || !ID_RE.test(firmId)) throw refuse(400, 'Choose an invitation', 'bad_request');
    await authStore.respondToInvitation(ctx.auth.userId, firmId, accept); // records the event
    const pending = await authStore.pendingInvitations(ctx.auth.userId);
    if (pending.length) return { reply: { next: 'invitations', invitations: pending } };
    const firms = await authStore.memberships(ctx.auth.userId);
    if (firms.length === 1) {
      const m = firms[0];
      const r = await sessions.rotate(ctx.auth.session, { firmId: m.firmId });
      return { reply: { stage: 'full', next: null, firmId: m.firmId, firmName: m.firmName, role: m.role, roles: m.roles, csrf: r.csrf }, headers: { 'Set-Cookie': r.cookie } };
    }
    return { reply: { next: firms.length ? 'firm' : 'none' } };
  }

  async function forgot(ctx) {
    const { email } = ctx.body || {};
    if (typeof email !== 'string' || !email.trim() || email.length > 254) throw refuse(400, 'An email address is required', 'bad_request');
    ctx.email = email;
    const user = await authStore.findUserByEmail(email);
    const firms = user ? await authStore.memberships(user.id) : [];
    if (!user) await event(ctx, null, 'reset_requested', 'unknown');
    else if (!user.active || !firms.length) await event(ctx, user.id, 'reset_requested', 'inactive');
    else {
      const { token } = await authStore.issueToken(user.id, 'reset', RESET_TTL_MS);
      await notify.resetLink(user, token);
      await event(ctx, user.id, 'reset_requested', 'sent');
    }
    return { reply: { ok: true } };
  }

  // The password through a link (reset or invitation): policy and breach list, every session ends
  async function throughLink(ctx, purpose, ev) {
    const { token, password } = ctx.body || {};
    if (typeof password !== 'string') throw refuse(400, 'A password is required', 'bad_request');
    const problem = checkPolicy(password);
    if (problem) throw refuse(400, problem, 'weak_password');
    const count = await breachedCount(password, breached);
    if (count) throw refuse(400, 'That password has appeared in a data breach. Choose a different one.', 'breached_password');
    const user = await authStore.consumeToken(token, purpose);
    if (!user) { await event(ctx, null, ev, 'bad_token'); throw refuse(400, 'This link is no longer valid. Ask for a new one.', 'bad_token'); }
    ctx.email = user.email;
    await authStore.setPassword(user.id, await hashPassword(password));
    await authStore.recordSuccess(user.id);
    await sessions.revokeAll(user.id, {});
    await event(ctx, user.id, ev, 'ok', count === null ? 'breach check skipped' : '');
    return user;
  }
  const reset = async ctx => { await throughLink(ctx, 'reset', 'reset'); return { reply: { ok: true } }; };
  const invite = async ctx => { const user = await throughLink(ctx, 'invite', 'invite'); return { reply: { ok: true, email: user.email } }; };

  async function requestAccess(ctx) {
    const b = ctx.body || {};
    const name = typeof b.name === 'string' ? b.name.trim() : '', email = typeof b.email === 'string' ? b.email.trim() : '';
    const firm = typeof b.firm === 'string' ? b.firm.trim() : '', note = typeof b.note === 'string' ? b.note.trim() : '';
    if (!name || name.length > 200 || !EMAIL.test(email) || email.length > 254 || firm.length > 200 || note.length > 1000 || /[\u0000-\u001F\u007F]/.test(name + firm + email)) throw refuse(400, 'Give your name, a valid email address, and at most 200 characters for the firm and 1,000 for the note', 'bad_request');
    const l = requestLimiter.hit(ctx.ip);
    if (!l.allowed) throw refuse(429, 'Too many requests from this address. Try again later.', 'too_many_attempts');
    ctx.email = email;
    await authStore.createAccessRequest({ name, email, firm, note, ip: ctx.ip });
    await event(ctx, null, 'access_request', 'stored', firm);
    await notify.accessRequest({ name, email, firm, note, ip: ctx.ip });
    return { reply: { ok: true } };
  }

  async function state(ctx) {
    const user = await authStore.findUser(ctx.auth.userId);
    const next = ctx.auth.stage === 'full' ? (ctx.auth.firmId ? null : ((await authStore.pendingInvitations(user.id)).length ? 'invitations' : 'firm')) : (user.totp_confirmed_at && !user.reenrol ? 'totp' : 'enrol');
    return { reply: { stage: ctx.auth.stage, next, csrf: ctx.auth.csrf, email: user.email } };
  }

  const ROUTES = {
    'POST /api/auth/forgot': { stage: 'none', limited: true, fn: forgot },
    'POST /api/auth/reset': { stage: 'none', limited: true, fn: reset },
    'POST /api/auth/invite': { stage: 'none', limited: true, fn: invite },
    'POST /api/auth/request-access': { stage: 'none', limited: true, fn: requestAccess },
    'GET /api/auth/state': { stage: 'any', fn: state },
    'POST /api/auth/sign-in': { stage: 'none', limited: true, fn: signIn },
    'POST /api/auth/sign-out': { stage: 'any', fn: signOut },
    'POST /api/auth/sign-out-all': { stage: 'full', fn: signOutAll },
    'GET /api/auth/firms': { stage: 'full', fn: firms },
    'POST /api/auth/firm': { stage: 'full', fn: switchFirm },
    'GET /api/auth/invitations': { stage: 'full', fn: invitations },
    'POST /api/auth/invitations/accept': { stage: 'full', fn: ctx => answerInvitation(ctx, true) },
    'POST /api/auth/invitations/decline': { stage: 'full', fn: ctx => answerInvitation(ctx, false) },
    'POST /api/auth/totp': { stage: 'any', limited: true, fn: totp },
    'POST /api/auth/enrol': { stage: 'any', fn: enrol },
    'POST /api/auth/enrol/confirm': { stage: 'any', limited: true, fn: confirmEnrol },
    'POST /api/auth/recovery': { stage: 'any', limited: true, fn: recovery },
    'POST /api/auth/password': { stage: 'full', fn: changePassword },
  };
  const guardsOf = r => [requireStage(r.stage), ...(r.limited ? [limited(limiter, clientIpHeader)] : [])];
  for (const r of Object.values(ROUTES)) r.guards = guardsOf(r);
  const add = (key, route) => { ROUTES[key] = { ...route, guards: guardsOf(route) }; };

  // true when the request was one of these routes (and has been answered)
  async function handle({ req, res, p, auth, send, readBody }) {
    if (!p.startsWith('/api/auth/')) return false;
    const route = ROUTES[`${req.method} ${p}`];
    if (!route) { send(res, 404, { error: 'Not found' }); return true; }
    if (auth && auth.locked) { send(res, 429, { error: 'Too many failed sign-ins. Try again in 15 minutes.', code: 'locked_out' }); return true; }
    const session = auth && auth.session ? auth : null;
    // The route's own guards (middleware/guards.js), in order: the stage it needs (with the CSRF token on a session write), then the per-address limit
    for (const guard of route.guards) {
      const refused = guard({ req, p, auth });
      if (refused) { send(res, ...refused); return true; }
    }
    const ip = ipOf(req, clientIpHeader);
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
