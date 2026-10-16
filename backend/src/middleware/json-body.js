/* Gate 9, json-body: a write must say it carries JSON, so a plain form post from another site
   (which a browser sends without a preflight) is refused before any body is read. The body itself
   is read by http/respond.js readBody: 413 over the size limit, 400 when it is not valid JSON.
   Returns null when the call may go ahead, else [status, body]. */
'use strict';

function checkJson(req) {
  if (req.method === 'GET') return null;
  if (!(req.headers['content-type'] || '').includes('application/json')) return [415, { error: 'Send JSON', code: 'json_required' }];
  return null;
}

module.exports = { checkJson };
