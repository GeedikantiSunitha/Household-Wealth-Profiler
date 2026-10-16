/* Gate 6, second-step: a session whose second step (the authenticator code) is still pending may
   reach only the routes that finish signing in, and is 401 second_step_required everywhere else. */
'use strict';

const SECOND_STEP_PATHS = new Set(['/api/auth/totp', '/api/auth/enrol', '/api/auth/enrol/confirm', '/api/auth/recovery', '/api/auth/sign-out', '/api/auth/state']);

function createSecondStep({ send }) {
  return function secondStep(ctx) {
    if ((ctx.auth.stage || 'full') === 'full' || SECOND_STEP_PATHS.has(ctx.p)) return false;
    send(ctx.res, 401, { error: 'Finish signing in: enter the code from your authenticator app', code: 'second_step_required' });
    return true;
  };
}

module.exports = { createSecondStep, SECOND_STEP_PATHS };
