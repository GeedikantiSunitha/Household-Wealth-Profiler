// frontend/.env.example lists every setting the front end uses (the container and the development
// server), holds no back-end setting and no secret; and the development server reads frontend/.env.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readEnvFile } = require('../../scripts/dev-server.js');

const FRONTEND = path.join(__dirname, '..', '..');
const doc = () => fs.readFileSync(path.join(FRONTEND, '.env.example'), 'utf8');

test('every setting the front end uses is in frontend/.env.example', () => {
  const used = new Set();
  for (const m of fs.readFileSync(path.join(FRONTEND, 'scripts', 'dev-server.js'), 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
  for (const m of fs.readFileSync(path.join(FRONTEND, 'nginx.conf.template'), 'utf8').matchAll(/\$\{([A-Z][A-Z0-9_]+)\}/g)) used.add(m[1]);
  used.delete('API_UPSTREAM'); // the earlier name: accepted, documented as such, not listed as a setting of its own
  assert.deepEqual([...used].sort(), ['API_HOST', 'BACKEND_URL', 'FRONTEND_DIR', 'FRONTEND_PORT']);
  const missing = [...used].filter(n => !new RegExp(`^#?\\s*${n}=`, 'm').test(doc()));
  assert.deepEqual(missing, []);
  assert.match(doc(), /API_UPSTREAM, its earlier name/);
});

test('no back-end setting and no secret belongs to the front end', () => {
  for (const n of ['DATABASE_URL', 'DATA_KEY', 'SMTP_URL', 'AUTH_USERS', 'BACKUP_KEY', 'DB_LOGIN_MODE', 'PUBLIC_URL']) assert.doesNotMatch(doc(), new RegExp(`^#?\\s*${n}=`, 'm'), n);
});

test('the development server reads frontend/.env; the environment wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-fe-env-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'BACKEND_URL=http://from-file:8080\nFRONTEND_PORT=6000\n');
    const env = { FRONTEND_PORT: '7000' };
    readEnvFile(file, env);
    assert.deepEqual(env, { FRONTEND_PORT: '7000', BACKEND_URL: 'http://from-file:8080' });
    readEnvFile(path.join(dir, 'missing'), env); // no file: nothing changes
    assert.equal(env.BACKEND_URL, 'http://from-file:8080');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
