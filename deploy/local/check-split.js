#!/usr/bin/env node
/* The smoke check of a split-address deployment (the front end and the back end on two addresses):
     node deploy/local/check-split.js FRONT_URL BACK_URL
   Proves what the browser relies on: the front end tells the page where the back end is and its
   content security policy allows exactly that address; the back end answers the browser's preflight
   for the front end and for no one else, marks its replies readable by the front end only, accepts a
   write from the front end's origin and refuses one from another, and serves no screens itself.
   Exit 0 when every check passes, 1 otherwise. Nothing is created that a repeat would not. */
'use strict';

const front = (process.argv[2] || 'http://localhost:8088').replace(/\/+$/, '');
const back = (process.argv[3] || 'http://localhost:8089').replace(/\/+$/, '');
const EVIL = 'https://evil.example.com';
const checks = [];
const check = async (name, fn) => { try { checks.push(['PASS', name, await fn() || '']); } catch (e) { checks.push(['FAIL', name, e.message]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  await check('the front end names the back end in runtime-config.js, and its policy allows that address and no other', async () => {
    const r = await fetch(front + '/runtime-config.js');
    expect(r.status === 200, `status ${r.status}`);
    expect((await r.text()).includes(`window.HWP_API_BASE = '${back}';`), 'runtime-config.js does not name the back end');
    const page = await fetch(front + '/');
    const csp = page.headers.get('content-security-policy') || '';
    expect(csp.includes(`connect-src 'self' ${back};`), `connect-src is not "'self' ${back}": ${csp.match(/connect-src[^;]*/)}`);
    expect(!csp.includes('*'), 'the policy has a wildcard');
  });
  await check('the back end answers the front end\'s preflight with its own origin, credentials, and no wildcard', async () => {
    const r = await fetch(back + '/api/households', { method: 'OPTIONS', headers: { Origin: front, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } });
    expect(r.status === 204, `status ${r.status}`);
    expect(r.headers.get('access-control-allow-origin') === front, `allow-origin ${r.headers.get('access-control-allow-origin')}`);
    expect(r.headers.get('access-control-allow-credentials') === 'true', 'no credentials header');
    expect(/X-CSRF-Token/i.test(r.headers.get('access-control-allow-headers') || ''), 'X-CSRF-Token not allowed');
  });
  await check('a foreign origin gets no CORS header, on a preflight or on a call', async () => {
    for (const init of [{ method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST' } }, { headers: { Origin: EVIL } }]) {
      const r = await fetch(back + '/api/me', init);
      expect(r.headers.get('access-control-allow-origin') === null, `${init.method || 'GET'} from ${EVIL} got allow-origin ${r.headers.get('access-control-allow-origin')}`);
    }
  });
  await check('the front end can read the back end\'s refusal: /api/me is 401 JSON with the front end\'s origin on it', async () => {
    const r = await fetch(back + '/api/me', { headers: { Origin: front } });
    expect(r.status === 401, `status ${r.status}`);
    expect(r.headers.get('access-control-allow-origin') === front, 'the refusal is not readable by the front end');
    expect((await r.json()).code === 'sign_in_required', 'code');
  });
  await check('a write from the front end\'s origin reaches the back end; one from another origin is 403 cross_site', async () => {
    const ok = await fetch(back + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: front }, body: '{}' });
    expect(ok.status === 400, `from the front end: status ${ok.status} (400 bad_request expected)`);
    expect(ok.headers.get('access-control-allow-origin') === front, 'the reply is not readable by the front end');
    const bad = await fetch(back + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EVIL }, body: '{}' });
    expect(bad.status === 403 && (await bad.json()).code === 'cross_site', `from ${EVIL}: status ${bad.status}`);
  });
  await check('the back end serves no screens: its own / and /index.html are 404', async () => {
    for (const p of ['/', '/index.html', '/core.js']) { const r = await fetch(back + p); expect(r.status === 404, `${p}: ${r.status}`); }
  });
  await check('the front end serves the page and core.js, and its health answers', async () => {
    for (const p of ['/', '/core.js', '/js/main.js', '/health']) { const r = await fetch(front + p); expect(r.status === 200, `${p}: ${r.status}`); }
  });
  for (const [s, name, detail] of checks) console.log(`${s}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  const failed = checks.filter(c => c[0] === 'FAIL').length;
  console.log(`${checks.length - failed} passed, ${failed} failed, front ${front}, back ${back}`);
  process.exitCode = failed ? 1 : 0;
})();
