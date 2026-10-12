// Server tests: starts a real server on a free port with a temporary data folder.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../packages/core/core.js');
const { apiContract } = require('./api-contract.js');

const ROOT = path.join(__dirname, '..', '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-test-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const user = (n, p) => execFileSync(process.execPath, ['server.js', 'hash-password', n, p], { cwd: ROOT }).toString().trim();
const KEY = execFileSync(process.execPath, ['server.js', 'gen-key'], { cwd: ROOT }).toString().trim();
const auth = (n, p) => ({ Authorization: 'Basic ' + Buffer.from(`${n}:${p}`).toString('base64') });
const SAM = auth('sam', 'correct horse'), CHRIS = auth('chris', 'battery staple');
const J = { 'Content-Type': 'application/json' };
let proc;

test.before(async () => {
  // DATABASE_URL is blanked so a developer's .env cannot point the test at a real database
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, DATA_KEY: KEY, DATABASE_URL: '', ALPHAVANTAGE_KEY: '', CLIENT_IP_HEADER: 'X-Client-IP',
    AUTH_USERS: [user('sam', 'correct horse'), user('chris', 'battery staple')].join(';') }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

// Windows delivers no signals (process.kill ends the process outright), so this runs on Linux and macOS, including CI
test('SIGTERM: no new connections, the request in flight finishes, then the process exits 0', { skip: process.platform === 'win32' && 'no signals on Windows' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-stop-'));
  const port = PORT + 7, env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, DATA_KEY: KEY, DATABASE_URL: '', ALPHAVANTAGE_KEY: '', AUTH_USERS: user('sam', 'correct horse') };
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'pipe' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    const body = JSON.stringify({ state: H.sample() });
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/households', headers: { ...SAM, ...J, 'Content-Length': Buffer.byteLength(body) } });
    const reply = new Promise(ok => req.on('response', res => { let t = ''; res.on('data', d => t += d); res.on('end', () => ok({ status: res.statusCode, body: t })); }));
    req.write(body.slice(0, 200)); // an upload that is still in progress when the signal arrives
    await new Promise(r => setTimeout(r, 200));
    const exited = new Promise(ok => p.on('exit', ok));
    p.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'a new connection is refused while stopping');
    req.end(body.slice(200));
    const r = await reply;
    assert.equal(r.status, 201, 'the request in flight was answered: ' + r.body);
    assert.equal(await exited, 0, 'exit code 0 after a clean stop');
  } finally { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('everything except the health check needs a login', async () => {
  assert.equal((await fetch(BASE + '/')).status, 401);
  assert.equal((await fetch(BASE + '/api/households')).status, 401);
  assert.equal((await fetch(BASE + '/api/me', { headers: auth('sam', 'wrong') })).status, 401);
  const r = await fetch(BASE + '/api/me', { headers: SAM });
  assert.deepEqual(await r.json(), { user: 'sam', encrypted: true, production: false });
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('the app and core are served; paths outside the app folder are not', async () => {
  const r = await fetch(BASE + '/', { headers: SAM });
  assert.equal(r.status, 200); assert.match(await r.text(), /Household Wealth Profiler/);
  assert.equal((await fetch(BASE + '/core.js', { headers: SAM })).status, 200);
  assert.equal((await fetch(BASE + '/..%2fserver.js', { headers: SAM })).status, 404);
  assert.equal((await fetch(BASE + '/api/households/..%2f..%2fetc', { headers: SAM })).status, 404);
});

let id;
test('create, save, version conflict and audit trail', async () => {
  let r = await fetch(BASE + '/api/households', { method: 'POST', headers: { ...SAM, ...J }, body: JSON.stringify({ state: H.sample() }) });
  assert.equal(r.status, 201); ({ id } = await r.json());

  r = await fetch(`${BASE}/api/households/${id}`, { headers: SAM });
  const rec = await r.json(); assert.equal(rec.version, 1); assert.equal(rec.state.household.name, 'Harrington household');

  const st = rec.state; st.members[1].poaType = 'bank'; st.compliance.reviewer = 'Chris';
  r = await fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...CHRIS, ...J }, body: JSON.stringify({ version: 1, state: st }) });
  assert.equal(r.status, 200); assert.equal((await r.json()).version, 2);

  // A stale save from someone still on version 1 is refused
  r = await fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 1, state: st }) });
  assert.equal(r.status, 409);

  const audit = await (await fetch(`${BASE}/api/households/${id}/audit`, { headers: SAM })).json();
  const poa = audit.find(a => a.field === 'members[1].poaType');
  assert.equal(poa.user, 'chris'); assert.equal(poa.from, 'none'); assert.equal(poa.to, 'bank');
  assert.ok(audit.some(a => a.field === 'created' && a.user === 'sam'));

  const list = await (await fetch(BASE + '/api/households', { headers: SAM })).json();
  assert.equal(list.length, 1); assert.equal(list[0].updatedBy, 'chris'); assert.ok(list[0].stage); assert.equal(typeof list[0].due, 'string'); assert.equal(typeof list[0].overdue, 'number');
});

test('files on disk are encrypted and every version is kept', () => {
  const dir = path.join(DATA, 'households', id);
  const cur = fs.readFileSync(path.join(dir, 'current.json'), 'utf8');
  assert.match(cur, /^enc:v1:/); assert.doesNotMatch(cur, /Harrington/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8'), /chris|bank/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'versions')).sort(), ['000001.json', '000002.json']);
});

test('unknown fields are dropped and cross-site writes are refused', async () => {
  const st = H.sample(); st.household.evil = '<script>'; st.extra = 1;
  let r = await fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 2, state: st }) });
  assert.equal(r.status, 200);
  const rec = await (await fetch(`${BASE}/api/households/${id}`, { headers: SAM })).json();
  assert.equal(rec.state.household.evil, undefined); assert.equal(rec.state.extra, undefined);
  r = await fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...SAM, ...J, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  r = await fetch(`${BASE}/api/households`, { method: 'POST', headers: { ...SAM, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});

test('there is no way to delete a client file', async () => {
  const r = await fetch(`${BASE}/api/households/${id}`, { method: 'DELETE', headers: { ...SAM, ...J } });
  assert.equal(r.status, 404);
  assert.ok(fs.existsSync(path.join(DATA, 'households', id, 'current.json')));
});

test('firm settings are versioned, audited, encrypted on disk and kept out of the household list', async () => {
  const r0 = await (await fetch(BASE + '/api/firm', { headers: SAM })).json();
  assert.equal(r0.version, 0); assert.equal(r0.settings.providers.length, 20);
  r0.settings.firm.name = 'Alder Wealth LLP'; r0.settings.team.push({ name: 'Alex Paraplanner', role: 'Paraplanner', active: true });
  const put = await fetch(BASE + '/api/firm', { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 0, settings: r0.settings }) });
  assert.equal(put.status, 200); assert.equal((await put.json()).version, 1);
  const stale = await fetch(BASE + '/api/firm', { method: 'PUT', headers: { ...CHRIS, ...J }, body: JSON.stringify({ version: 0, settings: r0.settings }) });
  assert.equal(stale.status, 409);
  const r1 = await (await fetch(BASE + '/api/firm', { headers: CHRIS })).json();
  assert.equal(r1.settings.team[0].name, 'Alex Paraplanner'); assert.equal(r1.updatedBy, 'sam');
  const audit = await (await fetch(BASE + '/api/firm/audit', { headers: CHRIS })).json();
  assert.ok(audit.some(a => a.field === 'firm.name' && a.to === 'Alder Wealth LLP'));
  const raw = fs.readFileSync(path.join(DATA, 'households', 'firm', 'current.json'), 'utf8');
  assert.match(raw, /^enc:v1:/); assert.doesNotMatch(raw, /Alder/);
  const list = await (await fetch(BASE + '/api/households', { headers: SAM })).json();
  assert.ok(list.every(h => h.id !== 'firm'));
  assert.ok(list.every(h => Array.isArray(h.tasks)));
});

test('automatic prices are off unless a data key is configured', async () => {
  const r = await fetch(BASE + '/api/prices?symbol=VWRL.LON', { headers: SAM });
  assert.equal(r.status, 501);
  assert.match((await r.json()).error, /import a CSV/);
});

// File storage held to the shared API contract (before the lockout tests below)
apiContract(() => ({ base: BASE, sam: SAM, chris: CHRIS }));

test('behind a proxy, a lockout applies only to the client address the proxy reports', async () => {
  const from = ip => ({ 'X-Client-IP': ip });
  for (let i = 0; i < 10; i++) await fetch(BASE + '/api/me', { headers: { ...auth('sam', 'nope' + i), ...from('203.0.113.9') } });
  assert.equal((await fetch(BASE + '/api/me', { headers: { ...SAM, ...from('203.0.113.9') } })).status, 429);
  assert.equal((await fetch(BASE + '/api/me', { headers: { ...SAM, ...from('198.51.100.7') } })).status, 200);
});

test('ten wrong passwords lock the address out for 15 minutes', async () => {
  for (let i = 0; i < 10; i++) await fetch(BASE + '/api/me', { headers: auth('sam', 'nope' + i) });
  const r = await fetch(BASE + '/api/me', { headers: SAM });
  assert.equal(r.status, 429);
});
