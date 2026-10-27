/* The API server: every request goes through the middleware gates (middleware/index.js, in
   their fixed order) and then one route. The order is part of the security:
     1. parse-url, 2. health, 3. api-only
        the public landing page (/welcome) and its images are served here, before sign-in (http/static.js)
     4. authenticate
        the sign-in routes (/api/auth/, routes/auth.js) branch off here: same-site and json-body,
        then each route's own guards (stage, rate limit)
        with the app's own sign-in the screens are served here too, before anyone is signed in
        (the shell holds no data)
     5. sign-in-required, 6. second-step, 7. firm-required
        with Basic sign-in (development) the screens are served here, after sign-in
     8. same-site, 9. json-body, 10. csrf, for anything that changes something
     then the routes (routes/*.js) call the controllers; anything else is 404
   An error a step raises with a status (413, 400) is sent with its message, its code and, for a
   refused record, its list of problems; any other error is logged and answered "Server error"
   (500) without detail. Every error reply carries a code (see http/respond.js). */
'use strict';
const http = require('http');
const path = require('path');
const { securityHeaders, createSend, readBody } = require('./http/respond.js');
const { createStatic, isPublicPage, publicFile } = require('./http/static.js');
const { createGates, checkWrite } = require('./middleware');
const { createMeRoute } = require('./routes/me.js');
const { createHouseholdRoutes } = require('./routes/households.js');
const { createFirmRoutes } = require('./routes/firm.js');
const { createMembersRoutes } = require('./routes/members.js');
const { createPriceRoute } = require('./routes/prices.js');
const { createRecordsRoutes } = require('./routes/records.js');
const { ID_RE } = require('./repositories/ids.js');

function createApp({ config, households, firm, prices, records = null, authenticate, authRoutes = null, members = null, ready = async () => {}, basicUsers = config.users ? config.users.size > 0 : true, publicShell = !!authRoutes && !basicUsers, serveWeb = config.serveWeb !== false }) {
  const send = createSend(securityHeaders({ hsts: config.hsts }));
  const serveStatic = createStatic({ publicDir: config.webDir || path.join(config.root, 'frontend', 'src'), coreFile: path.join(config.root, 'packages', 'core', 'core.js'), send });
  const origins = config.frontendOrigins || [];
  const gates = createGates({ send, ready, serveWeb, basicUsers, authenticate, origins });
  const routes = [
    createMeRoute({ send, encrypted: !!config.key, production: !!config.production, totpRequired: config.totpRequired !== false }),
    createFirmRoutes({ firm, send, readBody }),
    createPriceRoute({ prices, send }),
    createHouseholdRoutes({ households, ID_RE, send, readBody }),
    ...(records ? [createRecordsRoutes({ records, ID_RE, send, readBody })] : []),
    ...(members ? [createMembersRoutes({ members, send, readBody })] : []), // the team: only with the app's own sign-in (PostgreSQL)
  ];
  const files = ctx => (ctx.req.method === 'GET' ? serveStatic(ctx.req, ctx.res, ctx.p) : send(ctx.res, 405, { error: 'Method not allowed' }));

  async function handle(req, res) {
    const ctx = { req, res };
    if (gates.parseUrl(ctx)) return;
    if (await gates.health(ctx)) return;
    if (gates.cors(ctx)) return;
    if (gates.apiOnly(ctx)) return;
    if (serveWeb && req.method === 'GET' && isPublicPage(ctx.p)) return serveStatic(req, res, publicFile(ctx.p));
    await gates.authenticate(ctx);
    const { p, auth } = ctx;
    if (authRoutes && p.startsWith('/api/auth/')) {
      const refused = checkWrite(req, origins);
      if (refused) return send(res, ...refused);
      return authRoutes.handle({ req, res, p, auth, send, readBody });
    }
    if (publicShell && !p.startsWith('/api/')) return files(ctx);
    if (gates.signInRequired(ctx)) return;
    if (gates.secondStep(ctx)) return;
    if (gates.firmRequired(ctx)) return;
    if (!p.startsWith('/api/')) return files(ctx);
    if (gates.sameSite(ctx) || gates.jsonBody(ctx) || gates.csrf(ctx)) return;
    // Everything a route and service may act on: who is signed in, and the one firm they work in
    const routeCtx = { user: auth.user, firmId: auth.firmId, ...(auth.session ? { userId: auth.userId, email: auth.email, name: auth.name, firmName: auth.firmName, role: auth.role, roles: auth.roles, stage: auth.stage, csrf: auth.csrf, session: auth.session } : {}) };
    for (const route of routes) if (await route(req, res, p, routeCtx)) return;
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err.status || 500;
      if (status === 500) console.error(new Date().toISOString(), req.method, req.url, err);
      if (!res.headersSent) send(res, status, status === 500 ? { error: 'Server error' } : { error: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
    });
  });
  server.headersTimeout = 20e3;
  server.requestTimeout = 30e3;
  return { server, handle };
}

module.exports = { createApp };
