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
const { ipOf, createLimiter } = require('../middleware/rate-limit.js');
const { requireStage, limited } = require('../middleware/guards.js');
const { createAuthController, WARN_AT, REQUEST_LIMIT } = require('../controllers/auth.js');

function createAuthRoutes({ limiter, clientIpHeader = '', now = Date.now, requestLimiter = null, ...rest }) {
  // The per-address limit on Request Access (a few per hour), beside the sign-in limiter the routes share
  requestLimiter = requestLimiter || createLimiter({ ...REQUEST_LIMIT, now });
  const c = createAuthController({ limiter, clientIpHeader, now, requestLimiter, ...rest });
  const ROUTES = {
    'POST /api/auth/forgot': { stage: 'none', limited: true, fn: c.forgot },
    'POST /api/auth/reset': { stage: 'none', limited: true, fn: c.reset },
    'POST /api/auth/invite': { stage: 'none', limited: true, fn: c.invite },
    'POST /api/auth/request-access': { stage: 'none', limited: true, fn: c.requestAccess },
    'GET /api/auth/state': { stage: 'any', fn: c.state },
    'POST /api/auth/sign-in': { stage: 'none', limited: true, fn: c.signIn },
    'POST /api/auth/sign-out': { stage: 'any', fn: c.signOut },
    'POST /api/auth/sign-out-all': { stage: 'full', fn: c.signOutAll },
    'GET /api/auth/firms': { stage: 'full', fn: c.firms },
    'POST /api/auth/firm': { stage: 'full', fn: c.switchFirm },
    'GET /api/auth/invitations': { stage: 'full', fn: c.invitations },
    'POST /api/auth/invitations/accept': { stage: 'full', fn: ctx => c.answerInvitation(ctx, true) },
    'POST /api/auth/invitations/decline': { stage: 'full', fn: ctx => c.answerInvitation(ctx, false) },
    'POST /api/auth/totp': { stage: 'any', limited: true, fn: c.totp },
    'POST /api/auth/enrol': { stage: 'any', fn: c.enrol },
    'POST /api/auth/enrol/confirm': { stage: 'any', limited: true, fn: c.confirmEnrol },
    'POST /api/auth/recovery': { stage: 'any', limited: true, fn: c.recovery },
    'POST /api/auth/password': { stage: 'full', fn: c.changePassword },
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
