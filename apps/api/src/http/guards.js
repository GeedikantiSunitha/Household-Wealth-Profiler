/* Checks on every API call that changes something (anything but GET). Basic credentials are sent by
   the browser automatically, so a write must come from this site's own pages (CSRF protection),
   and must be JSON. Returns null when the call may go ahead, else [status, body]. */
'use strict';

function checkWrite(req) {
  if (req.method === 'GET') return null;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin && new URL(origin).host !== host) return [403, { error: 'Cross-site request refused' }];
  if (!(req.headers['content-type'] || '').includes('application/json')) return [415, { error: 'Send JSON' }];
  return null;
}

module.exports = { checkWrite };
