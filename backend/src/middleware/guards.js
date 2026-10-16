/* Per-route guards: what one route needs beyond the global gates. Each returns a check
   (ctx) => null to go ahead, else [status, body, headers?], for the route table to run in order
   before its controller. ctx carries req, auth (the sign-in result) and p.
     requireStage('none' | 'any' | 'full')   none: no session needed (signing in itself);
                                             any: a session at any stage; full: the second step done,
                                             and a write carries the session's CSRF token
     limited(limiter, clientIpHeader)        at most `max` attempts per address in the window (429)
     requireRole(action)                     the signed-in roles may do this action (403 forbidden,
                                             naming the action); the services check again, and the
                                             records service also logs a refusal, so a route whose
                                             refusals must be logged leaves this to the service */
'use strict';
const { ipOf } = require('./rate-limit.js');
const { checkCsrf } = require('./csrf.js');
const { can, authorize } = require('../services/access.js');

const SECOND_STEP = [401, { error: 'Finish signing in: enter the code from your authenticator app', code: 'second_step_required' }];
const SIGN_IN = [401, { error: 'Sign in required', code: 'sign_in_required' }];

function requireStage(stage) {
  return function stageGuard(ctx) {
    if (stage === 'none') return null;
    const session = ctx.auth && ctx.auth.session ? ctx.auth : null;
    if (!session) return SIGN_IN;
    if (stage === 'full' && session.stage !== 'full') return SECOND_STEP;
    return checkCsrf(ctx.req, session);
  };
}

function limited(limiter, clientIpHeader = '') {
  return function limitGuard(ctx) {
    const l = limiter.hit(ipOf(ctx.req, clientIpHeader));
    if (l.allowed) return null;
    return [429, { error: 'Too many attempts from this address. Try again in 15 minutes.', code: 'too_many_attempts' }, { 'Retry-After': String(l.retryAfter) }];
  };
}

function requireRole(action) {
  return function roleGuard(ctx) {
    if (can(ctx.auth, action)) return null;
    try { authorize(ctx.auth, action); return null; } catch (e) { return [e.status || 403, { error: e.message, code: e.code || 'forbidden' }]; }
  };
}

module.exports = { requireStage, limited, requireRole };
