// apps/api/src/crypto/seal.js: encryption at rest. The most important property is that data
// sealed before this module existed still opens, so a fixed sample sealed by the old server.js
// code (commit 2585ab4) is checked here.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSealer, PREFIX } = require('../../apps/api/src/crypto/seal.js');

const KEY = Buffer.alloc(32, 7); // test key only
const PLAIN = '{"id":"vector","name":"Harrington household","ni":"QQ123456C"}';
// Sealed with KEY by the seal() function that was in server.js at commit 2585ab4
const OLD_VECTOR = 'enc:v1:4WwkLbMK3psruT8SeJmCHCHDaMYTR3sZag/TEXobDnV4xNWFS/7sUj/YFPm7ugwNzkowy7l3448ZTBP3UinAfD34WmYL8+jvtdPK7FNYljtdfBjKLrK39ZqV';

test('data sealed by the old server.js code still opens', () => {
  assert.equal(createSealer(KEY).open(OLD_VECTOR), PLAIN);
});

test('with a key: enc:v1 format, no readable text, round trip', () => {
  const { seal, open } = createSealer(KEY);
  const s = seal(PLAIN);
  assert.ok(s.startsWith(PREFIX));
  assert.doesNotMatch(s, /Harrington|QQ123456C/);
  const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
  assert.equal(raw.length, 12 + 16 + Buffer.byteLength(PLAIN), 'IV 12 bytes + tag 16 bytes + ciphertext');
  assert.equal(open(s), PLAIN);
  assert.equal(open(seal('')), '');
  assert.equal(open(seal('£ é ✓ 中')), '£ é ✓ 中');
});

test('every seal uses a fresh IV, so the same text never looks the same twice', () => {
  const { seal } = createSealer(KEY);
  assert.notEqual(seal(PLAIN), seal(PLAIN));
});

test('tampered data, or the wrong key, is refused rather than returned', () => {
  const { seal, open } = createSealer(KEY);
  const raw = Buffer.from(seal(PLAIN).slice(PREFIX.length), 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => open(PREFIX + raw.toString('base64')));
  assert.throws(() => createSealer(crypto.randomBytes(32)).open(OLD_VECTOR));
});

test('without a key: text is stored and read as it is; encrypted data cannot be read', () => {
  const { seal, open } = createSealer(null);
  assert.equal(seal(PLAIN), PLAIN);
  assert.equal(open(PLAIN), PLAIN);
  assert.throws(() => open(OLD_VECTOR), { message: 'Data is encrypted but DATA_KEY is not set' });
});

test('plain text stored earlier (before a key was set) still opens once a key is set', () => {
  assert.equal(createSealer(KEY).open(PLAIN), PLAIN);
});
