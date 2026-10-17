// backend/src/auth/password.js: scrypt at the OWASP parameters, a dummy check that costs the same
// for unknown accounts, the password policy, the progressive delay after failures, and the
// breached-password lookup by k-anonymity (only a 5-character hash prefix ever leaves the server).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword, dummyVerify, dummyHashString, checkPolicy, delayAfter, breachedCount, SCRYPT, MIN_LENGTH, MAX_LENGTH } = require('../../../backend/src/services/auth/password.js');

test('scrypt parameters follow current OWASP guidance: N 2^17, r 8, p 1, 64-byte key, 16-byte salt', () => {
  assert.deepEqual(SCRYPT, { N: 131072, r: 8, p: 1, keylen: 64, saltBytes: 16 });
});

test('a hash records its parameters, verifies the right password only, and no two hashes of one password match', async () => {
  const t0 = process.hrtime.bigint();
  const h = await hashPassword('correct horse battery staple');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.match(h, /^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/, h);
  assert.equal(await verifyPassword(h, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(h, 'correct horse battery stapl'), false);
  assert.equal(await verifyPassword(h, ''), false);
  assert.notEqual(await hashPassword('correct horse battery staple'), h, 'a fresh salt every time');
  console.log(`one scrypt hash at the OWASP parameters took ${ms.toFixed(0)} ms on this machine`);
});

test('a malformed or foreign hash never verifies, and never throws', async () => {
  for (const bad of [null, undefined, '', 'plain', 'scrypt$16384$8$1$abc$def', 'bcrypt$2b$12$x', 'scrypt$131072$8$1$' + 'A'.repeat(22)]) assert.equal(await verifyPassword(bad, 'anything'), false, String(bad));
});

test('the dummy check for an unknown account runs a real scrypt at the same parameters, so the time taken does not tell accounts apart', async () => {
  assert.match(await dummyHashString(), /^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/, 'the dummy hash carries the real parameters, so verifying against it costs the same');
  assert.equal(await dummyVerify('wrong password here'), false, 'the dummy never verifies');
  assert.equal(await dummyVerify(''), false);
  // Timings are reported, not judged: under a loaded test run a ratio is not a sound assertion
  const time = async fn => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const real = await hashPassword('some password here');
  console.log(`verify against a real hash ${(await time(() => verifyPassword(real, 'wrong password here'))).toFixed(0)} ms, against the dummy ${(await time(() => dummyVerify('wrong password here'))).toFixed(0)} ms`);
});

test('policy: 12 to 200 characters, not blank; any characters allowed', () => {
  assert.equal(MIN_LENGTH, 12); assert.equal(MAX_LENGTH, 200);
  assert.equal(checkPolicy('correct horse battery staple'), null);
  assert.equal(checkPolicy('pässwörd £ ✓ 123'), null);
  assert.equal(checkPolicy('short pw 12'), 'Use at least 12 characters');
  assert.equal(checkPolicy('            '), 'Use at least 12 characters');
  assert.equal(checkPolicy('x'.repeat(201)), 'Use at most 200 characters');
  assert.equal(checkPolicy(12345678901234), 'Use at least 12 characters');
});

test('progressive delay: none for the first two failures, then 1, 2, 4, 8 ... seconds, capped at 60', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50].map(delayAfter), [0, 0, 0, 1, 2, 4, 8, 16, 32, 60, 60, 60]);
});

test('breached-password lookup: only the first 5 hex characters of the SHA-1 go out; the count comes back; a failure is null, never an error', async () => {
  const pw = 'password', sha1 = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase();
  const calls = [];
  const fetchOk = async (url, opts) => { calls.push([url, opts]); return { ok: true, text: async () => `00000:3\n${sha1.slice(5)}:9545824\nFFFFF:1\n` }; };
  assert.equal(await breachedCount(pw, { fetch: fetchOk }), 9545824);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://api.pwnedpasswords.com/range/' + sha1.slice(0, 5));
  assert.equal(calls[0][1].headers['Add-Padding'], 'true');
  assert.ok(!JSON.stringify(calls).includes(sha1.slice(5)), 'the rest of the hash never leaves');
  assert.equal(await breachedCount('a very unusual passphrase 7f3k', { fetch: async () => ({ ok: true, text: async () => '00000:1\n' }) }), 0);
  const logged = [];
  assert.equal(await breachedCount(pw, { fetch: async () => { throw new Error('network down'); }, log: m => logged.push(m) }), null);
  assert.equal(await breachedCount(pw, { fetch: async () => ({ ok: false, status: 503, text: async () => '' }), log: m => logged.push(m) }), null);
  assert.equal(logged.length, 2); assert.match(logged[0], /breached-password check skipped: network down/);
  assert.equal(await breachedCount(pw, { fetch: () => new Promise(() => {}), timeoutMs: 50, log: m => logged.push(m) }), null, 'a hung lookup times out');
});
