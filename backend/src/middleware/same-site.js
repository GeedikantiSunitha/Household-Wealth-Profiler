/* Gate 9, same-site: a write (anything but GET) must come from this site's own pages. Basic
   credentials and cookies are sent by the browser automatically, so a page on another site could
   otherwise make a signed-in user's browser change records (CSRF). Returns null when the call may
   go ahead, else [status, body]. An Origin of "null" (a sandboxed or opaque page) or one that is
   not a URL is not this site. A request without an Origin header (a script, curl) passes here and
   is held to the JSON check and, for a session, the CSRF token.
   "This site" is the address the request was made to (the Host the web tier forwards, or the
   back end's own), and in the split-address mode (FRONTEND_ORIGIN) also each origin in the
   allowlist, compared whole: scheme, host and port. Anything else is a foreign site. */
'use strict';

const REFUSED = [403, { error: 'Cross-site request refused', code: 'cross_site' }];

function checkSameSite(req, origins = []) {
  if (req.method === 'GET') return null;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin) {
    if (origins.includes(origin)) return null;
    let originHost;
    try { originHost = new URL(origin).host; } catch (e) { return REFUSED; }
    if (originHost !== host) return REFUSED;
  }
  return null;
}

module.exports = { checkSameSite };
