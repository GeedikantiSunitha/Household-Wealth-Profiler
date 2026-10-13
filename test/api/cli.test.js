// apps/api/src/cli and the server.js entry point: the commands people and deploy scripts run.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashPasswordCommand, genKeyCommand } = require('../../apps/api/src/cli');
const { parseUsers } = require('../../apps/api/src/config');
const { createBasicAuth } = require('../../apps/api/src/auth/providers/basic');
const { DEFAULT_FIRM_ID } = require('../../apps/api/src/repositories/ids.js');

const ROOT = path.join(__dirname, '..', '..');
const USAGE = 'Usage: node server.js hash-password NAME PASSWORD (name without : or ;)';
const capture = (t, fn) => { const out = [], err = []; t.mock.method(console, 'log', s => out.push(s)); t.mock.method(console, 'error', s => err.push(s)); const code = fn(); return { code, out, err }; };

test('hash-password prints an AUTH_USERS entry that signs in', t => {
  const { code, out, err } = capture(t, () => hashPasswordCommand(['dana', 's3cret:with colon']));
  assert.equal(code, 0); assert.deepEqual(err, []);
  assert.match(out[0], /^dana:[0-9a-f]{32}:[0-9a-f]{128}$/);
  const signIn = createBasicAuth({ users: parseUsers(out[0]) }).authenticate;
  assert.deepEqual(signIn({ headers: { authorization: 'Basic ' + Buffer.from('dana:s3cret:with colon').toString('base64') }, socket: { remoteAddress: 'x' } }), { user: 'dana', firmId: DEFAULT_FIRM_ID });
});

test('migrate and index-references need a database setting', () => {
  const run = args => spawnSync(process.execPath, ['server.js', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, DATABASE_URL: '', DATABASE_OWNER_URL: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', PUBLIC_URL: '', AUTH_USERS: 'x', DATA_KEY: '', ALLOW_PLAINTEXT: '1' } });
  const m = run(['migrate']);
  assert.equal(m.status, 1); assert.match(m.stderr, /Set DATABASE_OWNER_URL \(or DATABASE_URL\) to the database to migrate/);
  const i = run(['index-references']);
  assert.equal(i.status, 1); assert.match(i.stderr, /Set DATABASE_URL/);
});

test('hash-password refuses a missing password or a name with ":" or ";"', t => {
  for (const args of [[], ['dana'], ['da:na', 'pw'], ['da;na', 'pw']]) {
    const { code, out, err } = capture(t, () => hashPasswordCommand(args));
    assert.equal(code, 1, JSON.stringify(args)); assert.deepEqual(out, []); assert.deepEqual(err, [USAGE]);
  }
});

test('gen-key prints 32 random bytes, base64', t => {
  const a = capture(t, genKeyCommand), b = capture(t, genKeyCommand);
  assert.equal(a.code, 0);
  assert.equal(Buffer.from(a.out[0], 'base64').length, 32);
  assert.notEqual(a.out[0], b.out[0]);
});

test('node server.js runs the commands: exit codes and output unchanged', () => {
  const run = args => spawnSync(process.execPath, ['server.js', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  const key = run(['gen-key']);
  assert.equal(key.status, 0); assert.equal(Buffer.from(key.stdout.trim(), 'base64').length, 32);
  const bad = run(['hash-password', 'x']);
  assert.equal(bad.status, 1); assert.equal(bad.stderr.trim(), USAGE);
});

test('requiring server.js does not start anything', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./server.js'); console.log('loaded')"], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), 'loaded'); assert.equal(r.stderr, '');
});
