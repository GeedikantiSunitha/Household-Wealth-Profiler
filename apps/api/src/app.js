/* The API server: every request goes through the same steps, in this order.
     0. a request whose URL cannot be parsed is 400 "Bad request"
     1. GET /healthz answers without signing in (the process is up); GET /readyz answers without
        signing in once storage answers too (200), else 503 with no detail (for the host's checks)
     2. sign-in: 429 while the address is locked out, 401 with a Basic challenge when not signed in;
        a session whose second step is pending reaches only the second-step and sign-out routes (401)
     3. anything outside /api/ is one of the app's files (GET only, else 405)
     4. any API call that changes something: same-site check (403), then JSON check (415); with a
        cookie session, the CSRF token bound to that session must come in X-CSRF-Token (403)
     5. the API routes; anything else is 404
   An error a step raises with a status (413, 400) is sent with its message, its code and, for a
   refused record, its list of problems; any other error is logged and answered "Server error"
   (500) without detail. Every error reply carries a code (see http/respond.js). */
'use strict';
const http = require('http');
const path = require('path');
const { securityHeaders, createSend, readBody } = require('./http/respond.js');
const { createStatic } = require('./http/static.js');
const { checkWrite } = require('./http/guards.js');
const { createMeRoute } = require('./routes/me.js');
const { createHouseholdRoutes } = require('./routes/households.js');
const { createFirmRoutes } = require('./routes/firm.js');
const { createPriceRoute } = require('./routes/prices.js');
const { ID_RE } = require('./repositories/ids.js');

const CHALLENGE = { 'WWW-Authenticate': 'Basic realm="Household Wealth Profiler", charset="UTF-8"' };
// What a session may call while its second step is still pending
const SECOND_STEP_PATHS = new Set(['/api/auth/totp', '/api/auth/enrol', '/api/auth/enrol/confirm', '/api/auth/recovery', '/api/auth/sign-out']);
const READY_TIMEOUT_MS = 3000;

// ready() must answer within the time limit, or the readiness check reports not ready
function withinTime(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer));
}

function createApp({ config, households, firm, prices, authenticate, ready = async () => {}, basicUsers = config.users ? config.users.size > 0 : true }) {
  const send = createSend(securityHeaders({ hsts: config.hsts }));
  const serveStatic = createStatic({ publicDir: path.join(config.root, 'apps', 'web', 'public'), coreFile: path.join(config.root, 'packages', 'core', 'core.js'), send });
  const routes = [
    createMeRoute({ send, encrypted: !!config.key, production: !!config.production }),
    createFirmRoutes({ firm, send, readBody }),
    createPriceRoute({ prices, send }),
    createHouseholdRoutes({ households, ID_RE, send, readBody }),
  ];

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/readyz') {
      try { await withinTime(ready(), READY_TIMEOUT_MS); return send(res, 200, { ok: true }); }
      catch (e) { console.error(new Date().toISOString(), 'not ready:', e.message); return send(res, 503, { ok: false }); }
    }
    const auth = await authenticate(req);
    if (!auth || auth.locked) {
      return send(res, auth && auth.locked ? 429 : 401, { error: auth && auth.locked ? 'Too many failed sign-ins. Try again in 15 minutes.' : 'Sign in required' },
        auth && auth.locked ? {} : basicUsers ? CHALLENGE : {});
    }
    if ((auth.stage || 'full') !== 'full' && !SECOND_STEP_PATHS.has(p)) return send(res, 401, { error: 'Finish signing in: enter the code from your authenticator app', code: 'second_step_required' });
    // Everything a route and service may act on: who is signed in, and the one firm they work in
    const ctx = { user: auth.user, firmId: auth.firmId, ...(auth.session ? { userId: auth.userId, email: auth.email, name: auth.name, firmName: auth.firmName, role: auth.role, stage: auth.stage, csrf: auth.csrf, session: auth.session } : {}) };
    if (!p.startsWith('/api/')) return req.method === 'GET' ? serveStatic(req, res, p) : send(res, 405, { error: 'Method not allowed' });
    const refused = checkWrite(req);
    if (refused) return send(res, ...refused);
    if (auth.session && req.method !== 'GET' && req.headers['x-csrf-token'] !== auth.csrf) return send(res, 403, { error: 'Request refused: the sign-in token is missing or stale. Reload the page.', code: 'csrf' });
    for (const route of routes) if (await route(req, res, p, ctx)) return;
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
