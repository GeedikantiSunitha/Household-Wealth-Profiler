// Server tests: starts a real server on a free port with a temporary data folder.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../public/core.js');
const { apiContract } = require('./helpers/api-contract.js');

const ROOT = path.join(__dirname, '..');
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
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, DATA_KEY: KEY, DATABASE_URL: '', CLIENT_IP_HEADER: 'X-Client-IP',
    AUTH_USERS: [user('sam', 'correct horse'), user('chris', 'battery staple')].join(';') }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('everything except the health check needs a login', async () => {
  assert.equal((await fetch(BASE + '/')).status, 401);
  assert.equal((await fetch(BASE + '/api/households')).status, 401);
  assert.equal((await fetch(BASE + '/api/me', { headers: auth('sam', 'wrong') })).status, 401);
  const r = await fetch(BASE + '/api/me', { headers: SAM });
  assert.deepEqual(await r.json(), { user: 'sam', encrypted: true });
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
