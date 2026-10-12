/* Checks on every API call that changes something (anything but GET). Basic credentials are sent by
   the browser automatically, so a write must come from this site's own pages (CSRF protection),
   and must be JSON. Returns null when the call may go ahead, else [status, body].
   An Origin of "null" (a sandboxed or opaque page) or one that is not a URL is not this site. */
'use strict';

const REFUSED = [403, { error: 'Cross-site request refused' }];

function checkWrite(req) {
  if (req.method === 'GET') return null;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch (e) { return REFUSED; }
    if (originHost !== host) return REFUSED;
  }
  if (!(req.headers['content-type'] || '').includes('application/json')) return [415, { error: 'Send JSON' }];
  return null;
}

module.exports = { checkWrite };
