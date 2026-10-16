/* Gate 5, sign-in-required: nothing past here without a signed-in request. 429 while the address
   is locked out after too many failed sign-ins; 401 "Sign in required" otherwise, with a Basic
   challenge only when Basic users are configured (development), so a browser shows its box. */
'use strict';

const CHALLENGE = { 'WWW-Authenticate': 'Basic realm="Household Wealth Profiler", charset="UTF-8"' };

function createSignInRequired({ send, basicUsers = false }) {
  return function signInRequired(ctx) {
    const auth = ctx.auth;
    if (auth && !auth.locked) return false;
    const locked = !!(auth && auth.locked);
    send(ctx.res, locked ? 429 : 401, { error: locked ? 'Too many failed sign-ins. Try again in 15 minutes.' : 'Sign in required' }, !locked && basicUsers ? CHALLENGE : {});
    return true;
  };
}

module.exports = { createSignInRequired, CHALLENGE };
