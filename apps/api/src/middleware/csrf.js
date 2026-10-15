/* Gate 10, csrf: a write on a cookie session must carry the session's own token in X-CSRF-Token.
   The token is handed to the page at sign-in and bound to the session (auth/sessions.js), so a
   request a browser was tricked into sending cannot have it. Returns null to go ahead, else
   [status, body]. Basic sign-in (development) has no session and is covered by same-site alone. */
'use strict';

const REFUSED = [403, { error: 'Request refused: the sign-in token is missing or stale. Reload the page.', code: 'csrf' }];

function checkCsrf(req, auth) {
  if (req.method === 'GET' || !auth || !auth.session) return null;
  return req.headers['x-csrf-token'] === auth.csrf ? null : REFUSED;
}

module.exports = { checkCsrf };
