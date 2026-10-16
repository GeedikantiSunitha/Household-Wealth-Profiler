#!/usr/bin/env node
/* The smoke check of a two-service deployment, through the web tier:
     node deploy/local/check.js https://HOST      (or http://localhost:8088 for the rehearsal)
   Proves what the split must keep true: the page and core.js are served byte for byte, with the
   security headers; the API answers behind the same domain; a cross-site write is refused and a
   same-site one reaches the API. Exit 0 when every check passes, 1 otherwise. Nothing is created. */
'use strict';
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'http://localhost:8088').replace(/\/+$/, '');
const core = fs.readFileSync(path.join(__dirname, '..', '..', 'packages', 'core', 'core.js'));
const checks = [];
const check = async (name, fn) => { try { const detail = await fn(); checks.push(['PASS', name, detail || '']); } catch (e) { checks.push(['FAIL', name, e.message]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  await check('the page: 200, HTML, the content security policy and the other headers', async () => {
    const r = await fetch(base + '/');
    expect(r.status === 200, `status ${r.status}`);
    expect((r.headers.get('content-type') || '').includes('text/html'), 'not HTML');
    for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy']) expect(r.headers.get(h), `no ${h} header`);
    expect(/default-src 'self'/.test(r.headers.get('content-security-policy')), 'CSP is not the app\'s');
    expect((await r.text()).includes('js/main.js'), 'the page does not load js/main.js');
  });
  await check('core.js: byte for byte the one in packages/core', async () => {
    const r = await fetch(base + '/core.js');
    expect(r.status === 200, `status ${r.status}`);
    const served = Buffer.from(await r.arrayBuffer());
    expect(served.equals(core), `differs (${served.length} vs ${core.length} bytes)`);
    return `${core.length} bytes`;
  });
  await check('the bundle, the vendored library and the styles are served', async () => {
    for (const p of ['/js/main.js', '/vendor/xlsx.full.min.js', '/styles.css']) {
      const r = await fetch(base + p); expect(r.status === 200, `${p}: ${r.status}`);
    }
  });
  await check('the web tier health and the API health and readiness, through the same domain', async () => {
    expect((await fetch(base + '/health')).status === 200, '/health');
    const h = await fetch(base + '/healthz'); expect(h.status === 200 && (await h.json()).ok === true, '/healthz');
    const ready = await fetch(base + '/readyz'); expect(ready.status === 200, `/readyz ${ready.status}: the API cannot reach the database, or a migration is pending`);
  });
  await check('the API asks for sign-in: /api/me is 401 JSON with no Basic challenge', async () => {
    const r = await fetch(base + '/api/me');
    expect(r.status === 401, `status ${r.status}`);
    const j = await r.json(); expect(j.code === 'sign_in_required', `code ${j.code}`);
    expect(!r.headers.get('www-authenticate'), 'a Basic challenge is sent: AUTH_USERS is set');
  });
  await check('a cross-site write is refused by the API behind the proxy (403 cross_site)', async () => {
    const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    expect(r.status === 403, `status ${r.status}`); expect((await r.json()).code === 'cross_site', 'code');
  });
  await check('a same-site write reaches the API (the public host is forwarded): an empty registration is 400 bad_request', async () => {
    const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' });
    expect(r.status === 400, `status ${r.status} (403 means X-Forwarded-Host is not the public host)`); expect((await r.json()).code === 'bad_request', 'code');
  });
  await check('nothing outside the page is served by the API: /index.html comes from the web tier only', async () => {
    const r = await fetch(base + '/index.html'); expect(r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'), 'index.html');
    const r2 = await fetch(base + '/api/'); expect(r2.status === 401 || r2.status === 404, `/api/ ${r2.status}`);
  });
  for (const [s, name, detail] of checks) console.log(`${s}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  const failed = checks.filter(c => c[0] === 'FAIL').length;
  console.log(`${checks.length - failed} passed, ${failed} failed, against ${base}`);
  process.exitCode = failed ? 1 : 0;
})();
