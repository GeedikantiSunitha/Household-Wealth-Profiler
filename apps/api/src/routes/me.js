/* GET /api/me: who is signed in, and whether client data is encrypted at rest. */
'use strict';

function createMeRoute({ send, encrypted }) {
  return function me(req, res, p, user) {
    if (p !== '/api/me' || req.method !== 'GET') return false;
    send(res, 200, { user, encrypted });
    return true;
  };
}

module.exports = { createMeRoute };
