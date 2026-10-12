// apps/api/src/crypto/seal.js: encryption at rest. The most important property is that data
// sealed before this module existed still opens, so a fixed sample sealed by the old server.js
// code (commit 2585ab4) is checked here.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSealer, createFirmSealer, newDataKey, wrapKey, unwrapKey, normaliseReference, referenceIndex, indexKeyFor, PREFIX, PREFIX_V2 } = require('../../apps/api/src/crypto/seal.js');

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

test('envelope: a random firm key is wrapped by the master key and unwraps only with that master', () => {
  const firmKey = newDataKey();
  assert.equal(firmKey.length, 32);
  assert.notDeepEqual(newDataKey(), firmKey, 'random');
  const wrapped = wrapKey(KEY, firmKey);
  assert.match(wrapped, /^wk:v1:/);
  assert.doesNotMatch(wrapped, new RegExp(firmKey.toString('base64').slice(0, 10)));
  assert.deepEqual(unwrapKey(KEY, wrapped), firmKey);
  assert.throws(() => unwrapKey(crypto.randomBytes(32), wrapped));
  assert.notEqual(wrapKey(KEY, firmKey), wrapped, 'a fresh IV each time');
});

test('firm sealer: seals as enc:v2 with the firm key; opens enc:v1 with the master and plain text as it is', () => {
  const firmKey = newDataKey();
  const f = createFirmSealer({ master: KEY, firmKey });
  const s = f.seal(PLAIN);
  assert.ok(s.startsWith(PREFIX_V2));
  assert.doesNotMatch(s, /Harrington/);
  assert.equal(f.open(s), PLAIN, 'v2 opens with the firm key');
  assert.equal(f.open(OLD_VECTOR), PLAIN, 'v1 (master) still opens');
  assert.equal(f.open(PLAIN), PLAIN, 'plain text stored earlier');
  assert.throws(() => createSealer(KEY).open(s), 'the master alone cannot open a firm-key record');
  assert.throws(() => createFirmSealer({ master: KEY, firmKey: newDataKey() }).open(s), 'another firm key cannot either');
  const none = createFirmSealer({ master: null, firmKey: null });
  assert.equal(none.seal(PLAIN), PLAIN); assert.equal(none.open(PLAIN), PLAIN);
  assert.throws(() => none.open(s), { message: 'Data is encrypted but DATA_KEY is not set' });
});

test('reference index: the same reference in any spelling gives one index per firm, different per firm; empty has none', () => {
  assert.equal(normaliseReference('  hh-0001 '), 'HH-0001');
  assert.equal(normaliseReference('HH   0001\t'), 'HH 0001', 'inner whitespace collapses to one space');
  assert.equal(normaliseReference('ＨＨ－０００１'), 'HH-0001', 'full-width characters normalise (NFKC)');
  assert.equal(normaliseReference('straße'), 'STRASSE', 'upper-casing is Unicode-aware');
  assert.equal(normaliseReference(''), null); assert.equal(normaliseReference('   '), null); assert.equal(normaliseReference(undefined), null);
  const kA = indexKeyFor(newDataKey()), kB = indexKeyFor(newDataKey());
  assert.equal(indexKeyFor(Buffer.alloc(32, 1)).toString('hex'), indexKeyFor(Buffer.alloc(32, 1)).toString('hex'), 'derived, not random');
  assert.notEqual(kA.toString('hex'), kB.toString('hex'));
  assert.match(referenceIndex(kA, 'hh-0001'), /^[0-9a-f]{64}$/);
  assert.equal(referenceIndex(kA, 'hh-0001'), referenceIndex(kA, ' HH-0001 '));
  assert.notEqual(referenceIndex(kA, 'HH-0001'), referenceIndex(kA, 'HH-0002'));
  assert.notEqual(referenceIndex(kA, 'HH-0001'), referenceIndex(kB, 'HH-0001'), 'per firm');
  assert.equal(referenceIndex(kA, ''), null);
});
