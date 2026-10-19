#!/usr/bin/env node
/* npm start --workspace frontend: the front end on its own, for development. It does what the
   front-end container's nginx does: serves the screens and /core.js, and passes /api/, /healthz and
   /readyz to the back end at BACKEND_URL, so the browser sees one address. The security headers on
   the screens are read from nginx.conf.template, the container's own configuration, so a page here is
   as locked down as in production (and a script the policy would block fails here too).
     BACKEND_URL     the back end (default http://localhost:8080: npm start --workspace backend)
     FRONTEND_PORT   where to listen (default 5173)
     FRONTEND_DIR    what to serve (default frontend/src; frontend/dist checks a build)
   Development only: production serves frontend/dist from the nginx container. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
const API = /^\/(api\/|healthz$|readyz$)/;

// The headers nginx adds to the screens (location /), taken from the template itself
// (the one substitution: ${CONNECT_SRC_EXTRA}, the back end's address when it is not this one, else nothing)
function pageHeaders(template = fs.readFileSync(path.join(__dirname, '..', 'nginx.conf.template'), 'utf8'), apiBase = '') {
  const block = template.slice(template.indexOf('location / {'));
  const headers = {};
  for (const m of block.matchAll(/add_header ([\w-]+) "([^"]*)" always;/g)) headers[m[1]] = m[2].split('${CONNECT_SRC_EXTRA}').join(apiBase ? ' ' + apiBase : '');
  return headers;
}

function createDevServer({ apiBase = '', backendUrl = 'http://localhost:8080', dir = path.join(ROOT, 'frontend', 'src'), coreFile = path.join(ROOT, 'packages', 'core', 'core.js') } = {}) {
  const backend = new URL(backendUrl);
  const headers = pageHeaders(undefined, apiBase);
  const root = path.resolve(dir);
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // The front end's own health check, as the container answers it (the back end's are /healthz and /readyz, passed on)
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok\n'); return; }
    if (API.test(url.pathname)) {
      // To the back end, as nginx passes it: method, headers and body as they came, and the public host for the same-site check
      const up = http.request({ hostname: backend.hostname, port: backend.port || 80, path: req.url, method: req.method,
        headers: { ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http' } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('The back end does not answer at ' + backendUrl + '\n'); });
      req.pipe(up);
      return;
    }
    // The page's one run-time setting: where the back end is when it is not this address (empty: one address)
    if (url.pathname === '/runtime-config.js') { res.writeHead(200, { ...headers, 'Content-Type': TYPES['.js'] }); res.end(`window.HWP_API_BASE = '${apiBase}';\n`); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400, headers); res.end(); return; }
    const file = rel === '/core.js' ? coreFile : path.join(root, rel === '/' ? 'index.html' : rel);
    if (file !== coreFile && !file.startsWith(root + path.sep)) { res.writeHead(404, headers); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }); res.end('Not found\n'); return; }
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

module.exports = { createDevServer, pageHeaders };

// frontend/.env, the front end's own settings file (frontend/.env.example lists them); the environment wins
function readEnvFile(file = path.join(__dirname, '..', '.env'), env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const [k, v] of Object.entries(require('util').parseEnv(fs.readFileSync(file, 'utf8')))) if (!(k in env)) env[k] = v;
}

module.exports.readEnvFile = readEnvFile;

if (require.main === module) {
  readEnvFile();
  const backendUrl = process.env.BACKEND_URL || process.env.API_UPSTREAM || 'http://localhost:8080'; // as the container: the earlier name still works
  const port = +process.env.FRONTEND_PORT || 5173;
  const dir = process.env.FRONTEND_DIR ? path.resolve(process.env.FRONTEND_DIR) : undefined;
  const apiBase = String(process.env.API_BASE_URL || '').replace(/\/+$/, '');
  if (apiBase && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(apiBase)) { console.error('API_BASE_URL must be the back end\'s address as http(s)://host[:port], no path'); process.exit(1); }
  createDevServer({ apiBase, backendUrl, dir }).listen(port, '127.0.0.1', () => console.log(`Front end on http://localhost:${port} · /api/ passed to ${backendUrl}`));
}
