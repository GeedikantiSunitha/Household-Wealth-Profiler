// frontend/scripts/dev-server.js (npm start --workspace frontend): the front end on its own does what
// its nginx container does. The screens with the container's own security headers, /core.js from
// packages/core, /api/ passed to the back end with the public host, nothing outside frontend/src.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createDevServer, pageHeaders } = require('../../scripts/dev-server.js');

const ROOT = path.join(__dirname, '..', '..', '..');
// Every server a test starts is closed at the end, with its keep-alive connections, so the run can finish
const opened = [];
const listen = s => new Promise(ok => { opened.push(s); s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)); });

test.describe('the front end\'s development server', () => {
  let backend, fe, seen;
  test.before(async () => {
    backend = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen = { method: req.method, url: req.url, host: req.headers['x-forwarded-host'], csrf: req.headers['x-csrf-token'], body: b }; res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'hwp_session=s; HttpOnly; Path=/' }); res.end('{"ok":true}'); }); });
    const backendUrl = await listen(backend);
    fe = await listen(createDevServer({ backendUrl }));
  });
  test.after(() => { for (const s of opened) { s.closeAllConnections(); s.close(); } });

  test('the screens: index.html at /, with exactly the headers nginx adds in production', async () => {
    const r = await fetch(fe + '/');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.equal(await r.text(), fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'index.html'), 'utf8'));
    const want = pageHeaders();
    assert.ok(Object.keys(want).length >= 6, 'the headers are read from nginx.conf.template');
    for (const [k, v] of Object.entries(want)) assert.equal(r.headers.get(k), v, k);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self';/);
  });

  test('/core.js is packages/core/core.js byte for byte', async () => {
    const r = await fetch(fe + '/core.js');
    assert.equal(r.status, 200);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(path.join(ROOT, 'packages', 'core', 'core.js'))));
  });

  test('/api/ goes to the back end as it came (method, body, CSRF header) with the public host; the reply and its cookie come back', async () => {
    const r = await fetch(fe + '/api/households?x=1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 't' }, body: '{"a":1}' });
    assert.equal(r.status, 201); assert.deepEqual(await r.json(), { ok: true });
    assert.match(r.headers.get('set-cookie'), /^hwp_session=s/);
    assert.deepEqual(seen, { method: 'POST', url: '/api/households?x=1', host: new URL(fe).host, csrf: 't', body: '{"a":1}' });
    assert.equal((await fetch(fe + '/healthz')).status, 201, '/healthz is the back end\'s');
    const h = await fetch(fe + '/health');
    assert.equal(h.status, 200); assert.equal(await h.text(), 'ok\n', '/health is the front end\'s own, as in the container');
  });

  test('nothing outside frontend/src, no writes to the screens, and a back end that does not answer is 502', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json']) assert.equal((await fetch(fe + p)).status, 404, p);
    assert.equal((await fetch(fe + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(fe + '/nope.js')).status, 404);
    const lonely = await listen(createDevServer({ backendUrl: 'http://127.0.0.1:9' }));
    assert.equal((await fetch(lonely + '/api/me')).status, 502);
  });
});
