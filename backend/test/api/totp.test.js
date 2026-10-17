// backend/src/auth/totp.js: time-based one-time codes (RFC 6238, HMAC-SHA1, 6 digits, 30 s),
// checked against the RFC's own reference vectors; one step of clock drift either way; replay
// protection by the last accepted step; secrets as base32 and as an otpauth URI; recovery codes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { codeAt, verifyCode, generateSecret, otpauthUri, base32Decode, base32Encode, newRecoveryCodes, normaliseRecoveryCode, STEP_SECONDS, DIGITS } = require('../../../backend/src/services/auth/totp.js');

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
// RFC 6238 appendix B (SHA-1), the last 6 of the 8 digits shown there
const VECTORS = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];

test('the RFC 6238 reference vectors', () => {
  assert.equal(STEP_SECONDS, 30); assert.equal(DIGITS, 6);
  for (const [seconds, code] of VECTORS) assert.equal(codeAt(RFC_SECRET, Math.floor(seconds / 30)), code, String(seconds));
});

test('verify: the current step and one step either side; two steps away is refused; the accepted step is returned for replay protection', () => {
  const nowMs = 1111111111 * 1000, step = Math.floor(1111111111 / 30);
  assert.deepEqual(verifyCode(RFC_SECRET, '050471', { nowMs, lastStep: 0 }), { ok: true, step });
  assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 1), { nowMs, lastStep: 0 }), { ok: true, step: step - 1 }, 'the previous step (a slow clock)');
  assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step + 1), { nowMs, lastStep: 0 }), { ok: true, step: step + 1 }, 'the next step (a fast clock)');
  assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step + 2), { nowMs, lastStep: 0 }), { ok: false }, 'two steps ahead');
  assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 2), { nowMs, lastStep: 0 }), { ok: false }, 'two steps behind');
});

test('replay: a code at or before the last accepted step is refused even though it is otherwise valid', () => {
  const nowMs = 1111111111 * 1000, step = Math.floor(1111111111 / 30);
  assert.equal(verifyCode(RFC_SECRET, '050471', { nowMs, lastStep: step }).ok, false, 'the same step again');
  assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 1), { nowMs, lastStep: step }).ok, false, 'an earlier step after a later one was accepted');
  assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step + 1), { nowMs, lastStep: step }).ok, true, 'the next step is new');
});

test('codes are compared in constant time and only as 6 digits; spaces are ignored; anything else is refused', () => {
  const nowMs = 1111111111 * 1000;
  assert.equal(verifyCode(RFC_SECRET, '050 471', { nowMs, lastStep: 0 }).ok, true);
  for (const bad of ['', '05047', '0504711', 'abcdef', '050471\n', null, 50471, '050472']) assert.equal(verifyCode(RFC_SECRET, bad, { nowMs, lastStep: 0 }).ok, false, String(bad));
});

test('secrets: 20 random bytes, base32 without padding, round-tripped; the otpauth URI names the issuer, the account and the parameters', () => {
  const s = generateSecret();
  assert.equal(s.length, 20);
  const b32 = base32Encode(s);
  assert.match(b32, /^[A-Z2-7]{32}$/);
  assert.deepEqual(base32Decode(b32), s);
  assert.deepEqual(base32Decode(b32.toLowerCase().replace(/(.{4})/g, '$1 ')), s, 'lower case and spaces are accepted when typed');
  assert.notDeepEqual(generateSecret(), s);
  const uri = otpauthUri(s, 'sam@example.com', 'Household Wealth Profiler');
  assert.equal(uri, `otpauth://totp/Household%20Wealth%20Profiler:sam%40example.com?secret=${b32}&issuer=Household%20Wealth%20Profiler&algorithm=SHA1&digits=6&period=30`);
  assert.equal(base32Encode(RFC_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('recovery codes: ten, each 10 letters and digits shown as xxxxx-xxxxx, all different; normalised for comparison', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/, c);
  assert.equal(normaliseRecoveryCode(' ABCDE-FGHIJ '), 'abcde-fghij');
  assert.equal(normaliseRecoveryCode('abcdefghij'), 'abcde-fghij', 'the dash is optional when typed');
  assert.equal(normaliseRecoveryCode(''), '');
});
