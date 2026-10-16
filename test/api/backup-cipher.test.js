// backend/src/crypto/backup-cipher.js: backups are encrypted with BACKUP_KEY so that any change,
// cut, reordering, repetition or extension of the file, or the wrong key, fails decryption, and the
// manifest beside it cannot be altered unseen.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { encryptStream, decryptStream, keyId, signManifest, verifyManifest, HEADER_LEN } = require('../../backend/src/crypto/backup-cipher.js');

const KEY = crypto.randomBytes(32);
async function run(input, transform, { pieces = 7 } = {}) {
  const out = [];
  // fed in uneven pieces, as a pipe delivers them
  const parts = []; for (let i = 0; i < input.length; i += pieces) parts.push(input.subarray(i, i + pieces));
  await pipeline(Readable.from(parts.length ? parts : [Buffer.alloc(0)]), transform, new Writable({ write(c, e, d) { out.push(c); d(); } }));
  return Buffer.concat(out);
}
const enc = (plain, chunkSize = 64) => run(plain, encryptStream(KEY, { chunkSize }), { pieces: 1000 });
const dec = (cipher, key = KEY, pieces = 13) => run(cipher, decryptStream(key), { pieces });
// The byte offsets of each record in an encrypted file
function records(buf) { const out = []; let p = HEADER_LEN; while (p < buf.length) { const len = buf.readUInt32BE(p + 1); out.push([p, 5 + len + 16]); p += 5 + len + 16; } return out; }

test('round trip at every awkward size: empty, one byte, a chunk less one, a chunk, a chunk and one, many chunks', async () => {
  for (const n of [0, 1, 63, 64, 65, 64 * 5, 1000]) {
    const plain = crypto.randomBytes(n);
    const c = await enc(plain);
    assert.equal(c.subarray(0, 8).toString(), 'HWPBK001');
    assert.ok(!c.includes(plain.subarray(0, Math.min(16, n))) || n < 8, 'no plaintext in the file');
    assert.deepEqual(await dec(c), plain, `size ${n}`);
  }
});

test('the last record, and only the last, is marked final; two encryptions of the same data differ', async () => {
  const c = await enc(crypto.randomBytes(200));
  const rs = records(c);
  assert.deepEqual(rs.map(([p]) => c[p]), [0, 0, 0, 1]);
  assert.notDeepEqual(await enc(Buffer.from('same')), await enc(Buffer.from('same')));
});

test('a changed byte anywhere, a missing end, a dropped, swapped or repeated record, extra bytes, or the wrong key: refused', async () => {
  const plain = crypto.randomBytes(300);
  const c = await enc(plain);
  const rs = records(c);
  const bad = /damaged, incomplete or was made with a different BACKUP_KEY|Not a backup file/;
  for (const at of [0, 10, 41, HEADER_LEN + 2, HEADER_LEN + 7, c.length - 1]) { const t = Buffer.from(c); t[at] ^= 1; await assert.rejects(dec(t), bad, `byte ${at}`); }
  await assert.rejects(dec(c.subarray(0, rs[rs.length - 1][0])), bad, 'cut before the final record');
  await assert.rejects(dec(c.subarray(0, c.length - 3)), bad, 'cut inside the final record');
  await assert.rejects(dec(c.subarray(0, HEADER_LEN)), bad, 'header only');
  const [a, b] = [c.subarray(rs[0][0], rs[0][0] + rs[0][1]), c.subarray(rs[1][0], rs[1][0] + rs[1][1])];
  const head = c.subarray(0, HEADER_LEN), rest = c.subarray(rs[2][0]);
  await assert.rejects(dec(Buffer.concat([head, b, a, rest])), bad, 'swapped');
  await assert.rejects(dec(Buffer.concat([head, b, rest])), bad, 'dropped');
  await assert.rejects(dec(Buffer.concat([head, a, a, b, rest])), bad, 'repeated');
  await assert.rejects(dec(Buffer.concat([c, Buffer.from([0])])), bad, 'one byte added');
  await assert.rejects(dec(Buffer.concat([c, c.subarray(rs[0][0])])), bad, 'records added after the end');
  await assert.rejects(dec(c, crypto.randomBytes(32)), bad, 'wrong key');
  const other = await enc(crypto.randomBytes(300));
  await assert.rejects(dec(Buffer.concat([head, other.subarray(HEADER_LEN)])), bad, 'records from another file');
});

test('the manifest is signed: any change to it, or another key, fails the check; the key id names the key without revealing it', () => {
  const m = signManifest(KEY, { format: 1, counts: { 'public.households': 3 }, sha256: 'ab', migrations: ['0001_init.sql'] });
  assert.equal(verifyManifest(KEY, m), true);
  assert.equal(verifyManifest(KEY, JSON.parse(JSON.stringify({ migrations: m.migrations, mac: m.mac, sha256: m.sha256, counts: m.counts, format: 1 }))), true, 'key order does not matter');
  assert.equal(verifyManifest(KEY, { ...m, counts: { 'public.households': 4 } }), false);
  assert.equal(verifyManifest(KEY, { ...m, extra: 1 }), false);
  assert.equal(verifyManifest(crypto.randomBytes(32), m), false);
  assert.equal(verifyManifest(KEY, { ...m, mac: undefined }), false);
  assert.match(keyId(KEY), /^[0-9a-f]{16}$/); assert.equal(keyId(KEY), keyId(Buffer.from(KEY)));
  assert.notEqual(keyId(KEY), keyId(crypto.randomBytes(32)));
  assert.ok(!KEY.toString('hex').includes(keyId(KEY)));
});
