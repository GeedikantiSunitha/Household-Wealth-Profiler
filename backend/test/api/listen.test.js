// Where the server listens. With no HOST setting it listens on every address, IPv6 and IPv4 both,
// the way a Node server started with no address does (and the way the ModelMyWealth services that
// DCDeploy routes do): a platform that reaches the container over IPv6 then finds it, and one that
// uses IPv4 still does. A HOST setting still names one address exactly. The IPv6 half runs only on a
// machine that has an IPv6 loopback address.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitForServer } = require('./servers.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const hasIPv6 = Object.values(os.networkInterfaces()).flat().some(a => a && a.address === '::1');
const KEY = execFileSync(process.execPath, ['server.js', 'gen-key'], { cwd: ROOT }).toString().trim();
const USER = execFileSync(process.execPath, ['server.js', 'hash-password', 'sam', 'correct horse'], { cwd: ROOT }).toString().trim();
const get = (host, port, p = '/healthz') => new Promise((ok, no) => { http.get({ host, port, path: p, timeout: 5000, family: host.includes(':') ? 6 : 4 }, r => { let s = ''; r.on('data', d => { s += d; }); r.on('end', () => ok({ status: r.statusCode, body: s })); }).on('error', no); });

function start(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-listen-'));
  const port = 19000 + Math.floor(Math.random() * 900);
  const env = { ...process.env, PORT: String(port), HOST: '', DATA_DIR: dir, DATA_KEY: KEY, AUTH_USERS: USER, DATABASE_URL: '', DATABASE_OWNER_URL: '', DATABASE_OPERATOR_URL: '', DB_LOGIN_MODE: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', PUBLIC_URL: '', NODE_ENV: '', ...extraEnv };
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'pipe' });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  return { proc, port, dir, log: () => log };
}
const stop = s => { s.proc.kill(); fs.rmSync(s.dir, { recursive: true, force: true }); };

test('no HOST: reachable on 127.0.0.1 (IPv4) and, where the machine has it, on [::1] (IPv6); the start line says which', async () => {
  const s = start({});
  try {
    await waitForServer(s.proc, `http://127.0.0.1:${s.port}`);
    assert.deepEqual(await get('127.0.0.1', s.port), { status: 200, body: JSON.stringify({ ok: true }) });
    if (hasIPv6) assert.deepEqual(await get('::1', s.port), { status: 200, body: JSON.stringify({ ok: true }) }, 'IPv6 loopback answers too');
    assert.match(s.log(), new RegExp(`Household Wealth Profiler on http://(\\[::\\]|0\\.0\\.0\\.0):${s.port} `), 'the line names the address actually bound');
  } finally { stop(s); }
});

test('HOST=127.0.0.1: one address exactly, as before; IPv6 is not served', { skip: !hasIPv6 && 'no IPv6 loopback on this machine' }, async () => {
  const s = start({ HOST: '127.0.0.1' });
  try {
    await waitForServer(s.proc, `http://127.0.0.1:${s.port}`);
    assert.equal((await get('127.0.0.1', s.port)).status, 200);
    await assert.rejects(get('::1', s.port), /ECONNREFUSED/, 'a named address is the only one served');
    assert.match(s.log(), new RegExp(`on http://127\\.0\\.0\\.1:${s.port} `));
  } finally { stop(s); }
});
