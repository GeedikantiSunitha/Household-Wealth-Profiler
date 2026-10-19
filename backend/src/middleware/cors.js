/* Gate 3, cors: the split-address mode (FRONTEND_ORIGIN). The front end and the back end are on
   different addresses, so the browser asks the back end whether the front end's page may call it.
   This gate answers, and only for the origins in the allowlist:
     - every reply to an allowed origin carries Access-Control-Allow-Origin with that origin (never
       "*": a wildcard cannot be combined with cookies, and would let any site read a reply),
       Access-Control-Allow-Credentials: true, and Vary: Origin;
     - a preflight (OPTIONS under /api/) is answered 204 at once, before sign-in, with the methods
       and headers the app uses; the browser then sends the real request;
     - an origin that is not listed, a missing Origin and the string "null" get no CORS header at
       all, so the browser refuses to hand the reply to that page.
   With no allowlist (the default: one address, the web tier passing /api/ along) the gate does
   nothing and the behaviour is exactly what it was. The headers are set on the response before
   anything else writes it, so a refusal (401, 403, 429) is readable by the allowed front end too.
   Who may write is decided by the same-site gate (same-site.js) and the CSRF token, not here. */
'use strict';

const METHODS = 'GET, POST, PUT, PATCH, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, X-CSRF-Token, Idempotency-Key, Accept';
const MAX_AGE = '600';
const CORS_HEADERS = Object.freeze(['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers']);

function createCors({ origins = [] }) {
  const allowed = new Set(origins);
  return function cors(ctx) {
    if (!allowed.size) return false;
    const origin = ctx.req.headers.origin;
    if (!origin || !allowed.has(origin)) return false;
    const res = ctx.res;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (ctx.req.method === 'OPTIONS' && ctx.p.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Methods', METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE);
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  };
}

module.exports = { createCors, CORS_HEADERS, METHODS, ALLOW_HEADERS };
