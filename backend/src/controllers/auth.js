/* The sign-in controllers: the handler behind each route in routes/auth.js, which documents every
   route and runs its guards. Each takes ctx { ip, userAgent, auth, email, body } and returns
   { status?, reply, headers? } or throws an error with a status and code. Every outcome is an auth
   event. Secrets are sealed with DATA_KEY (rotate-key re-seals them). */
'use strict';
const crypto = require('crypto');
const { verifyPassword, dummyVerify, hashPassword, checkPolicy, breachedCount } = require('../services/auth/password.js');
const { generateSecret, base32Encode, base32Decode, otpauthUri, verifyCode, newRecoveryCodes, normaliseRecoveryCode } = require('../services/auth/totp.js');
const { ID_RE } = require('../repositories/ids.js');
const { normaliseEmail } = require('../repositories/auth-store.js');

const WARN_AT = 5;
const RESET_TTL_MS = 30 * 60e3;
const VERIFY_TTL_MS = 24 * 3600e3;
const REQUEST_LIMIT = Object.freeze({ max: 3, windowMs: 3600e3 });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const refuse = (status, error, code) => Object.assign(new Error(error), { status, code });
const BAD_CREDENTIALS = () => refuse(401, 'Email or password is not right', 'bad_credentials');
const SECOND_STEP = () => refuse(401, 'Finish signing in: enter the code from your authenticator app', 'second_step_required');

function createAuthController({ authStore, sessions, limiter, notify = {}, clientIpHeader = '', now = Date.now, sealer = { seal: t => t, open: t => t }, issuer = 'Household Wealth Profiler', breached = {}, requestLimiter, totpRequired = true }) {
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
    if (!user.email_verified_at) { await event(ctx, user.id, 'sign_in', 'unverified'); throw refuse(403, 'Confirm your email address first: open the link we sent you, or ask for a new one.', 'email_unverified'); }
    await authStore.recordSuccess(user.id);
    if (ctx.auth && ctx.auth.session) await sessions.revoke(ctx.auth);
    const s = await sessions.issue({ userId: user.id, stage: 'password', ip: ctx.ip, userAgent: ctx.userAgent });
    if (!totpRequired) {
      // TOTP_REQUIRED=0: no second step; the password alone opens a full session (not for real client data)
      await event(ctx, user.id, 'sign_in', 'ok', 'password; second step off');
      return finish({ ...ctx, auth: { session: { id_hash: s.idHash } } }, user);
    }
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
    await authStore.markVerified(user.id); // the link reached the address
    await authStore.recordSuccess(user.id);
    await sessions.revokeAll(user.id, {});
    await event(ctx, user.id, ev, 'ok', count === null ? 'breach check skipped' : '');
    return user;
  }
  const reset = async ctx => { await throughLink(ctx, 'reset', 'reset'); return { reply: { ok: true } }; };
  const invite = async ctx => { const user = await throughLink(ctx, 'invite', 'invite'); return { reply: { ok: true, email: user.email } }; };

  // Registration: name, email, firm and password; a firm of their own with the registrant as its
  // administrator; the address is confirmed through a link before the first sign-in. The reply is
  // the same whether or not the address already has an account (its holder is told by email).
  const str = v => (typeof v === 'string' ? v : '');
  async function register(ctx) {
    const b = ctx.body || {};
    const name = str(b.name).trim(), email = normaliseEmail(str(b.email)), firmName = str(b.firm).trim(), password = str(b.password);
    if (!name || name.length > 200 || !EMAIL.test(email) || email.length > 254 || !firmName || firmName.length > 200 || /[\u0000-\u001F\u007F]/.test(name + firmName + email)) throw refuse(400, 'Give your name, a valid email address, the name of your firm and a password', 'bad_request');
    const problem = checkPolicy(password);
    if (problem) throw refuse(400, problem, 'weak_password');
    const l = requestLimiter.hit(ctx.ip);
    if (!l.allowed) throw refuse(429, 'Too many registrations from this address. Try again later.', 'too_many_attempts');
    const count = await breachedCount(password, breached);
    if (count) throw refuse(400, 'That password has appeared in a data breach. Choose a different one.', 'breached_password');
    ctx.email = email;
    const r = await authStore.register({ email, name, firmName, passwordHash: await hashPassword(password) });
    if (r.exists) {
      await event(ctx, r.userId, 'register', 'exists');
      if (notify.alreadyRegistered) await notify.alreadyRegistered(r.user);
      return { reply: { ok: true } };
    }
    const { token } = await authStore.issueToken(r.userId, 'verify', VERIFY_TTL_MS);
    await notify.verifyLink({ email, name }, token);
    await event(ctx, r.userId, 'register', 'ok', `firm ${r.firmId}${count === null ? '; breach check skipped' : ''}`);
    return { reply: { ok: true } };
  }

  async function verify(ctx) {
    const { token } = ctx.body || {};
    const user = await authStore.consumeToken(token, 'verify');
    if (!user) { await event(ctx, null, 'verify', 'bad_token'); throw refuse(400, 'This link is no longer valid. Sign in and ask for a new one.', 'bad_token'); }
    ctx.email = user.email;
    await authStore.markVerified(user.id);
    await event(ctx, user.id, 'verify', 'ok');
    return { reply: { ok: true, email: user.email } };
  }

  // A new verification link, for an unconfirmed account only; the reply never says which it was
  async function resendVerification(ctx) {
    const { email } = ctx.body || {};
    if (typeof email !== 'string' || !email.trim() || email.length > 254) throw refuse(400, 'An email address is required', 'bad_request');
    const l = requestLimiter.hit(ctx.ip);
    if (!l.allowed) throw refuse(429, 'Too many requests from this address. Try again later.', 'too_many_attempts');
    ctx.email = email;
    const user = await authStore.findUserByEmail(email);
    if (user && user.active && !user.email_verified_at) {
      const { token } = await authStore.issueToken(user.id, 'verify', VERIFY_TTL_MS);
      await notify.verifyLink(user, token);
      await event(ctx, user.id, 'verify_resent', 'sent');
    } else await event(ctx, user ? user.id : null, 'verify_resent', user ? 'not_needed' : 'unknown');
    return { reply: { ok: true } };
  }

  async function state(ctx) {
    const user = await authStore.findUser(ctx.auth.userId);
    const next = ctx.auth.stage === 'full' ? (ctx.auth.firmId ? null : ((await authStore.pendingInvitations(user.id)).length ? 'invitations' : 'firm')) : (user.totp_confirmed_at && !user.reenrol ? 'totp' : 'enrol');
    return { reply: { stage: ctx.auth.stage, next, csrf: ctx.auth.csrf, email: user.email } };
  }

  return { totp, enrol, confirmEnrol, recovery, changePassword, signIn, signOut, signOutAll, firms, switchFirm, invitations, answerInvitation, forgot, reset, invite, register, verify, resendVerification, state };
}

module.exports = { createAuthController, WARN_AT, REQUEST_LIMIT };
