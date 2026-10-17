// The web tier (frontend/Dockerfile, nginx.conf.template) serves the screens with exactly the
// headers the API sends with them, so splitting the front end off loosens nothing; and the two
// images copy what they must: the web tier gets core.js from packages/core, the API image serves
// the API only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { securityHeaders } = require('../../../backend/src/http/respond.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the web tier sends every security header the API sends with a page, with the same value', () => {
  const conf = read('frontend/nginx.conf.template');
  const headers = securityHeaders({ hsts: false }); // HSTS is the API's and the TLS edge's: a plain http container must not set it
  for (const [name, value] of Object.entries(headers)) {
    assert.ok(conf.includes(`add_header ${name} "${value}" always;`), `${name} is missing or differs in nginx.conf.template`);
  }
  assert.match(conf, /location ~ \^\/\(api\/\|healthz\$\|readyz\$\)/, 'the API paths are passed through');
  assert.match(conf, /proxy_set_header X-Forwarded-Host \$http_host;/, 'the public host, with its port, reaches the API for its same-site check against the Origin header');
});

test('the images copy what they must, and the API image answers the API only', () => {
  const web = read('frontend/Dockerfile'), api = read('backend/Dockerfile');
  assert.match(web, /RUN node scripts\/build-web\.js/, 'the screens are built from frontend/src');
  assert.match(web, /COPY --from=build \/app\/frontend\/dist \/usr\/share\/nginx\/html/, 'nginx serves the build');
  assert.match(read('scripts/build-web.js'), /'packages', 'core', 'core\.js'/, 'the build copies core.js from packages/core, the one copy');
  assert.match(web, /NGINX_ENVSUBST_FILTER=\^\(API_HOST\|BACKEND_URL\)\$/, 'only BACKEND_URL and API_HOST are substituted; nginx variables stay');
  assert.match(web, /export BACKEND_URL=\\"\$\{BACKEND_URL:-\$\{API_UPSTREAM:-http:\/\/api:8080\}\}\\"/, 'BACKEND_URL, else the earlier API_UPSTREAM, else the local default');
  const conf = read('frontend/nginx.conf.template');
  assert.match(conf, /proxy_pass \$\{BACKEND_URL\};/, 'the API is reached at BACKEND_URL');
  assert.doesNotMatch(conf, /API_UPSTREAM/, 'the template knows one name only');
  assert.match(api, /SERVE_WEB=0/);
  assert.match(api, /USER node/);
  for (const dir of ['backend', 'db', 'packages']) assert.match(api, new RegExp(`COPY ${dir.replace('/', '\\/')} `), `the API image copies ${dir}`);
  assert.doesNotMatch(api, /COPY frontend(?!\/package\.json )/, 'the API image carries no screens (only the front end\'s package.json, which npm needs to install the workspaces)');
});
