/* Gate 3, api-only: with SERVE_WEB=0 the screens live in the web tier, so no path outside /api/
   exists here; it is 404 (JSON) before sign-in is even looked at. With the default, one server,
   this gate lets everything through and the files are served after sign-in. */
'use strict';

function createApiOnly({ serveWeb = true, send }) {
  return function apiOnly(ctx) {
    if (serveWeb || ctx.p.startsWith('/api/')) return false;
    send(ctx.res, 404, { error: 'Not found' });
    return true;
  };
}

module.exports = { createApiOnly };
