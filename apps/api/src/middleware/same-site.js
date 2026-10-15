/* Gate 8, same-site: a write (anything but GET) must come from this site's own pages. Basic
   credentials and cookies are sent by the browser automatically, so a page on another site could
   otherwise make a signed-in user's browser change records (CSRF). Returns null when the call may
   go ahead, else [status, body]. An Origin of "null" (a sandboxed or opaque page) or one that is
   not a URL is not this site. A request without an Origin header (a script, curl) passes here and
   is held to the JSON check and, for a session, the CSRF token. */
'use strict';

const REFUSED = [403, { error: 'Cross-site request refused', code: 'cross_site' }];

function checkSameSite(req) {
  if (req.method === 'GET') return null;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch (e) { return REFUSED; }
    if (originHost !== host) return REFUSED;
  }
  return null;
}

module.exports = { checkSameSite };
