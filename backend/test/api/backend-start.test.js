// backend/scripts/start.js (npm start --workspace backend): the back end on its own answers the API
// and its health checks, and serves no screen (SERVE_WEB=0), as its own service does.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { waitForServer } = require('./servers.js');

const ROOT = path.join(__dirname, '..', '..', '..');

test('the back end alone: /healthz and /api/ answer, the screens are not served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-be-'));
  const port = 21000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
  const user = execFileSync(process.execPath, ['server.js', 'hash-password', 'sam', 'correct horse'], { cwd: ROOT }).toString().trim();
  const proc = spawn(process.execPath, [path.join(ROOT, 'backend', 'scripts', 'start.js')], { cwd: ROOT, stdio: 'pipe',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ALLOW_PLAINTEXT: '1', DATA_KEY: '', DATABASE_URL: '', DATABASE_OWNER_URL: '', AUTH_USERS: user, HSTS: '0', SERVE_WEB: undefined, NODE_ENV: '', DB_LOGIN_MODE: '' } });
  try {
    await waitForServer(proc, base);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/api/me', { headers: { Authorization: 'Basic ' + Buffer.from('sam:correct horse').toString('base64') } })).status, 200);
    for (const p of ['/', '/index.html', '/core.js']) assert.equal((await fetch(base + p)).status, 404, `${p} is the front end's`);
  } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
