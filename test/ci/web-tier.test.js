// The web tier (apps/web/Dockerfile, nginx.conf.template) serves the screens with exactly the
// headers the API sends with them, so splitting the front end off loosens nothing; and the two
// images copy what they must: the web tier gets core.js from packages/core, the API image serves
// the API only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { securityHeaders } = require('../../apps/api/src/http/respond.js');

const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the web tier sends every security header the API sends with a page, with the same value', () => {
  const conf = read('apps/web/nginx.conf.template');
  const headers = securityHeaders({ hsts: false }); // HSTS is the API's and the TLS edge's: a plain http container must not set it
  for (const [name, value] of Object.entries(headers)) {
    assert.ok(conf.includes(`add_header ${name} "${value}" always;`), `${name} is missing or differs in nginx.conf.template`);
  }
  assert.match(conf, /location ~ \^\/\(api\/\|healthz\$\|readyz\$\)/, 'the API paths are passed through');
  assert.match(conf, /proxy_set_header X-Forwarded-Host \$http_host;/, 'the public host, with its port, reaches the API for its same-site check against the Origin header');
});

test('the images copy what they must, and the API image answers the API only', () => {
  const web = read('apps/web/Dockerfile'), api = read('apps/api/Dockerfile');
  assert.match(web, /COPY apps\/web\/public \/usr\/share\/nginx\/html/);
  assert.match(web, /COPY packages\/core\/core\.js \/usr\/share\/nginx\/html\/core\.js/, 'core.js comes from packages/core, the one copy');
  assert.match(web, /NGINX_ENVSUBST_FILTER=\^API_/, 'only API_* settings are substituted; nginx variables stay');
  assert.match(api, /SERVE_WEB=0/);
  assert.match(api, /USER node/);
  for (const dir of ['apps/api', 'db', 'packages']) assert.match(api, new RegExp(`COPY ${dir.replace('/', '\\/')} `), `the API image copies ${dir}`);
  assert.doesNotMatch(api, /COPY apps\/web/, 'the API image carries no screens');
});
