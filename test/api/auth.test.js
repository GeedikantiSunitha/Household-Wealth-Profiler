// apps/api/src/auth/providers/basic: HTTP Basic sign-in, lockout and login cache. A fake clock
// checks the 15-minute lock and the 5-minute cache without waiting.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBasicAuth, hashPassword, MAX_FAILURES, LOCK_MS, CACHE_MS } = require('../../apps/api/src/auth/providers/basic');
const { parseUsers } = require('../../apps/api/src/config');
const { DEFAULT_FIRM_ID } = require('../../apps/api/src/repositories/ids.js');
// Basic sign-in is development-only: every user belongs to the default firm
const firmId = DEFAULT_FIRM_ID;

const USERS = parseUsers([hashPassword('sam', 'correct horse'), hashPassword('chris', 'pa:ss:word'), hashPassword('zoë', 'ünïcode ✓')].join(';'));
const basic = (name, pass) => 'Basic ' + Buffer.from(`${name}:${pass}`, 'utf8').toString('base64');
const req = (authorization, ip = '10.0.0.1', headers = {}) => ({ headers: { ...(authorization ? { authorization } : {}), ...headers }, socket: { remoteAddress: ip } });
function setup(clientIpHeader = '') {
  const clock = { t: Date.parse('2026-10-10T10:00:00Z') };
  const a = createBasicAuth({ users: USERS, clientIpHeader, now: () => clock.t });
  return { clock, auth: a.authenticate, stats: a.stats };
}
const fail = (auth, ip, n) => { for (let i = 0; i < n; i++) assert.equal(auth(req(basic('sam', 'nope' + i), ip)), null); };

test('limits: 10 failures, 15-minute lock, 5-minute cache', () => {
  assert.equal(MAX_FAILURES, 10); assert.equal(LOCK_MS, 15 * 60e3); assert.equal(CACHE_MS, 5 * 60e3);
});

test('right name and password sign in; names are case-sensitive', () => {
  const { auth } = setup();
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { user: 'sam', firmId });
  assert.equal(auth(req(basic('SAM', 'correct horse'))), null);
});

test('passwords may contain colons and any characters; the name ends at the first colon', () => {
  const { auth } = setup();
  assert.deepEqual(auth(req(basic('chris', 'pa:ss:word'))), { user: 'chris', firmId });
  assert.deepEqual(auth(req(basic('zoë', 'ünïcode ✓'))), { user: 'zoë', firmId });
});

test('wrong password, unknown name, empty name and no colon are refused', () => {
  const { auth } = setup();
  assert.equal(auth(req(basic('sam', 'wrong'))), null);
  assert.equal(auth(req(basic('nobody', 'correct horse'))), null);
  assert.equal(auth(req(basic('', 'correct horse'))), null);
  assert.equal(auth(req('Basic ' + Buffer.from('samcorrect horse').toString('base64'))), null);
});

test('no credentials, or not Basic, is refused but never counts towards the lockout', () => {
  const { auth } = setup();
  for (let i = 0; i < 25; i++) { assert.equal(auth(req()), null); assert.equal(auth(req('Bearer abc')), null); }
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { user: 'sam', firmId });
});

test('10 failures lock the address for 15 minutes, even with the right password', () => {
  const { auth, clock } = setup();
  fail(auth, '10.0.0.1', 9);
  assert.equal(auth(req(basic('sam', 'nope9'))), null, '10th failure');
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { locked: true });
  assert.deepEqual(auth(req()), { locked: true }, 'locked comes before anything else');
  clock.t += LOCK_MS - 1;
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { locked: true }, 'still locked 1 ms before the end');
  clock.t += 1;
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { user: 'sam', firmId }, 'open again after 15 minutes');
});

test('the lock is per address; other addresses are not affected', () => {
  const { auth } = setup();
  fail(auth, '10.0.0.1', 10);
  assert.deepEqual(auth(req(basic('sam', 'correct horse'), '10.0.0.1')), { locked: true });
  assert.deepEqual(auth(req(basic('sam', 'correct horse'), '10.0.0.2')), { user: 'sam', firmId });
});

test('a success clears the count: 9 failures, a success, then 9 more do not lock', () => {
  const { auth } = setup();
  fail(auth, '10.0.0.1', 9);
  assert.deepEqual(auth(req(basic('chris', 'pa:ss:word'))), { user: 'chris', firmId });
  fail(auth, '10.0.0.1', 9);
  assert.deepEqual(auth(req(basic('zoë', 'ünïcode ✓'))), { user: 'zoë', firmId });
});

test('after a lock runs out, the count starts again from one', () => {
  const { auth, clock } = setup();
  fail(auth, '10.0.0.1', 10);
  clock.t += LOCK_MS;
  fail(auth, '10.0.0.1', 9);
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { user: 'sam', firmId }, '9 new failures are not enough');
});

test('failures older than 15 minutes no longer count towards the lock', () => {
  const { auth, clock } = setup();
  fail(auth, '10.0.0.1', 9);
  clock.t += LOCK_MS + 1;
  fail(auth, '10.0.0.1', 9);
  assert.deepEqual(auth(req(basic('sam', 'correct horse'))), { user: 'sam', firmId }, '9 old and 9 recent failures are not 10 recent ones');
});

test('an unknown name takes as long to refuse as a wrong password, so replies do not reveal which names exist', () => {
  const { auth } = setup();
  const ms = fn => { const s = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - s) / 1e6; };
  // Interleaved, and the fastest of each: the fastest run is the cost of the work itself, whatever
  // else the machine is doing (a median can be skewed when the suite runs alongside other processes)
  const wrong = [], unknown = [];
  for (let i = 0; i < 7; i++) {
    wrong.push(ms(() => auth(req(basic('sam', 'wrong' + i), '10.0.1.' + i))));
    unknown.push(ms(() => auth(req(basic('nobody' + i, 'x'), '10.0.2.' + i))));
  }
  const best = a => Math.min(...a);
  assert.ok(best(unknown) > best(wrong) * 0.5, `unknown name ${best(unknown).toFixed(1)} ms, wrong password ${best(wrong).toFixed(1)} ms`);
});

test('old failures and expired logins are pruned, so the maps never grow for ever', () => {
  const { auth, clock, stats } = setup();
  for (let i = 0; i < 50; i++) auth(req(basic('sam', 'nope'), '10.1.0.' + i));
  auth(req(basic('sam', 'correct horse'), '10.2.0.1')); auth(req(basic('chris', 'pa:ss:word'), '10.2.0.2')); auth(req(basic('zoë', 'ünïcode ✓'), '10.2.0.3'));
  assert.deepEqual(stats(), { failures: 50, cached: 3 });
  clock.t += LOCK_MS + 1; // nothing has been touched for over 15 minutes
  auth(req());
  assert.deepEqual(stats(), { failures: 0, cached: 0 });
});

test('behind a proxy: the configured header is the address; without the setting it is ignored', () => {
  const viaProxy = setup('x-client-ip').auth;
  for (let i = 0; i < 10; i++) viaProxy(req(basic('sam', 'nope' + i), '127.0.0.1', { 'x-client-ip': '203.0.113.9' }));
  assert.deepEqual(viaProxy(req(basic('sam', 'correct horse'), '127.0.0.1', { 'x-client-ip': '203.0.113.9' })), { locked: true });
  assert.deepEqual(viaProxy(req(basic('sam', 'correct horse'), '127.0.0.1', { 'x-client-ip': '198.51.100.7' })), { user: 'sam', firmId });
  const direct = setup('').auth;
  for (let i = 0; i < 10; i++) direct(req(basic('sam', 'nope' + i), '127.0.0.1', { 'x-client-ip': '203.0.113.' + i }));
  assert.deepEqual(direct(req(basic('sam', 'correct horse'), '127.0.0.1', { 'x-client-ip': '198.51.100.7' })), { locked: true }, 'a spoofed header does not dodge the lock');
});

test('a successful login is remembered for 5 minutes, then checked again', () => {
  const users = new Map(USERS);
  const clock = { t: 0 };
  const auth = createBasicAuth({ users, now: () => clock.t }).authenticate;
  const h = basic('sam', 'correct horse');
  assert.deepEqual(auth(req(h)), { user: 'sam', firmId });
  users.delete('sam'); // proves the next answers come from the cache, not a password check
  clock.t += CACHE_MS - 1;
  assert.deepEqual(auth(req(h)), { user: 'sam', firmId });
  clock.t += 1;
  assert.equal(auth(req(h)), null, 'after 5 minutes the password is checked again');
});

test('hashPassword makes an AUTH_USERS entry that signs in', () => {
  const entry = hashPassword('dana', 's3cret:with colon');
  assert.match(entry, /^dana:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.notEqual(hashPassword('dana', 'x'), hashPassword('dana', 'x'), 'random salt');
  const auth = createBasicAuth({ users: parseUsers(entry) }).authenticate;
  assert.deepEqual(auth(req(basic('dana', 's3cret:with colon'))), { user: 'dana', firmId });
});
