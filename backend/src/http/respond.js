/* Replies and request bodies. Every reply carries the security headers; JSON replies are never
   cached. Every error reply ({ error }) also carries a machine-readable code: the one the step
   that refused set, else the code for its status below. Request bodies are JSON, at most 2 MB. */
'use strict';

const MAX_BODY = 2 * 1024 * 1024;
const CODE_BY_STATUS = { 400: 'bad_request', 401: 'sign_in_required', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 415: 'json_required', 422: 'unprocessable', 429: 'locked_out', 500: 'server_error', 501: 'not_available', 502: 'upstream_error', 503: 'unavailable' };

function securityHeaders({ hsts }) {
  const h = {
    // Scripts only from this server: the spreadsheet library is served from frontend/src/vendor
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (hsts) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

// send(res, status, body, headers): an object body is sent as JSON; a string or Buffer as it is
function createSend(SEC_HEADERS) {
  return function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    if (isJson && body && typeof body.error === 'string' && !body.code) body = { error: body.error, code: CODE_BY_STATUS[status] || 'error', ...body };
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(payload);
  };
}

// The parsed JSON body ({} when empty). Rejects with status 413 over the limit, 400 for bad JSON.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413, code: 'too_large' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400, code: 'invalid_json' })); } });
    req.on('error', reject);
  });
}

module.exports = { securityHeaders, createSend, readBody, MAX_BODY, CODE_BY_STATUS };
