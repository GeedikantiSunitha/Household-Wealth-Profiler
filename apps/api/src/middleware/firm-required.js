/* Gate 7, firm-required: a full session that has not chosen a firm (several memberships, or an
   invitation to answer) may read who it is (/api/me) and nothing else: 403 firm_required. */
'use strict';

function createFirmRequired({ send }) {
  return function firmRequired(ctx) {
    const auth = ctx.auth;
    if (!auth.session || auth.firmId || ctx.p === '/api/me') return false;
    send(ctx.res, 403, { error: 'Choose a firm to work in', code: 'firm_required' });
    return true;
  };
}

module.exports = { createFirmRequired };
