/* GET /api/me: who is signed in, whether client data is encrypted at rest, and whether this is a
   production server (the interface then hides development conveniences such as sample data). */
'use strict';

function createMeRoute({ send, encrypted, production = false }) {
  return function me(req, res, p, user) {
    if (p !== '/api/me' || req.method !== 'GET') return false;
    send(res, 200, { user, encrypted, production });
    return true;
  };
}

module.exports = { createMeRoute };
