/* The middleware layer: the security checks every request passes before a controller runs. One
   file per check; app.js runs the global gates in exactly this order, then the routes.
     1 parse-url          400 on a URL that cannot be parsed; sets ctx.p
     2 health             GET /healthz (the process is up), GET /readyz (storage answers too)
     3 api-only           SERVE_WEB=0: nothing outside /api/ exists here (the web tier has the screens)
     4 authenticate       who the request comes from: a cookie session, or Basic in development
       (the sign-in routes under /api/auth/ branch off after this gate: same-site, json-body, then
       their own per-route guards, guards.js; the screens, when this server serves them, are
       answered after this gate when the app's own sign-in is on, else after gate 7)
     5 sign-in-required   401 (with a Basic challenge in development) or 429 while locked out
     6 second-step        401 until the authenticator code is given (a few routes are allowed)
     7 firm-required      403 until the session has a firm
     8 same-site          403 on a write whose Origin is not this site
     9 json-body          415 on a write that is not JSON (the body itself: http/respond.js readBody)
    10 csrf               403 on a session write without the session's token
   Per-route guards: guards.js (requireStage, limited, requireRole). Field validation against the
   rules in core.js is services/validate.js, applied by the services, so the commands and the
   importer are held to the same rules as the API.
   A gate is (ctx) => true when it answered the request (nothing else runs), false to go on. */
'use strict';
const { createParseUrl } = require('./parse-url.js');
const { createHealth } = require('./health.js');
const { createApiOnly } = require('./api-only.js');
const { createSignInRequired } = require('./sign-in-required.js');
const { createSecondStep } = require('./second-step.js');
const { createFirmRequired } = require('./firm-required.js');
const { checkSameSite } = require('./same-site.js');
const { checkJson } = require('./json-body.js');
const { checkCsrf } = require('./csrf.js');

const ORDER = Object.freeze(['parse-url', 'health', 'api-only', 'authenticate', 'sign-in-required', 'second-step', 'firm-required', 'same-site', 'json-body', 'csrf']);

// Gates 8 and 9 together, as the sign-in routes and the API both apply them: null, or [status, body]
const checkWrite = req => checkSameSite(req) || checkJson(req);

function createGates({ send, ready, serveWeb = true, basicUsers = false, authenticate }) {
  const asGate = check => ctx => { const r = check(ctx.req, ctx.auth); if (!r) return false; send(ctx.res, ...r); return true; };
  return {
    parseUrl: createParseUrl({ send }),
    health: createHealth({ ready, send }),
    apiOnly: createApiOnly({ serveWeb, send }),
    authenticate: async ctx => { ctx.auth = await authenticate(ctx.req); return false; },
    signInRequired: createSignInRequired({ send, basicUsers }),
    secondStep: createSecondStep({ send }),
    firmRequired: createFirmRequired({ send }),
    sameSite: asGate(checkSameSite),
    jsonBody: asGate(checkJson),
    csrf: asGate(checkCsrf),
  };
}

module.exports = { ORDER, createGates, checkWrite, checkSameSite, checkJson, checkCsrf };
