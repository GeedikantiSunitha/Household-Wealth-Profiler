/* Encryption of database backups with BACKUP_KEY, a key of its own: never DATA_KEY, so a stolen
   backup and a stolen server key are two separate losses, and the backup job never holds the key
   that opens client records.

   Format (all integers big-endian):
     header   "HWPBK001" (8 bytes) | salt (32 random bytes) | chunk size (4 bytes)
     records  final flag (1 byte: 0 or 1) | length (4 bytes) | ciphertext (length bytes) | tag (16 bytes)
   Each file has its own key, HKDF-SHA256(BACKUP_KEY, salt, "hwp backup v1"). Records are
   AES-256-GCM with the whole header as additional data and a nonce made of the record's number
   (11 bytes) and its final flag (1 byte), so a record cannot be changed, moved, dropped, repeated or
   taken from another file, and the file cannot be cut short or added to: decryption fails unless it
   ends with exactly one final record (the online authenticated-encryption "STREAM" construction).
   A failed check stops the stream with an error; nothing after it is passed on.

   The manifest beside each backup (what it holds, counts, checksum) is not secret but is signed
   with a key derived from BACKUP_KEY ("hwp backup manifest v1"), so it cannot be altered unseen. */
'use strict';
const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('HWPBK001');
const HEADER_LEN = 8 + 32 + 4;
const CHUNK = 1 << 20;
const TAG = 16;
const MAX_CHUNK = 1 << 24;

const fileKey = (key, salt) => Buffer.from(crypto.hkdfSync('sha256', key, salt, 'hwp backup v1', 32));
const nonce = (n, final) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 3); b[11] = final ? 1 : 0; return b; };
const BAD = () => new Error('The backup file is damaged, incomplete or was made with a different BACKUP_KEY');

function encryptStream(key, { chunkSize = CHUNK } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes');
  const salt = crypto.randomBytes(32);
  const header = Buffer.alloc(HEADER_LEN); MAGIC.copy(header, 0); salt.copy(header, 8); header.writeUInt32BE(chunkSize, 40);
  const k = fileKey(key, salt);
  let n = 0, pending = Buffer.alloc(0), started = false;
  const record = (plain, final) => {
    const c = crypto.createCipheriv('aes-256-gcm', k, nonce(n++, final)); c.setAAD(header);
    const body = Buffer.concat([c.update(plain), c.final()]);
    const head = Buffer.alloc(5); head[0] = final ? 1 : 0; head.writeUInt32BE(body.length, 1);
    return Buffer.concat([head, body, c.getAuthTag()]);
  };
  return new Transform({
    transform(chunk, enc, done) {
      if (!started) { this.push(header); started = true; }
      pending = Buffer.concat([pending, chunk]);
      // keep at least one byte back: the last record must be marked final, so a full chunk is only sent once more follows
      while (pending.length > chunkSize) { this.push(record(pending.subarray(0, chunkSize), false)); pending = pending.subarray(chunkSize); }
      done();
    },
    flush(done) {
      if (!started) this.push(header);
      this.push(record(pending, true));
      done();
    },
  });
}

function decryptStream(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes');
  let buf = Buffer.alloc(0), header = null, k = null, chunkSize = 0, n = 0, ended = false;
  return new Transform({
    transform(chunk, enc, done) {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (!header) {
          if (buf.length < HEADER_LEN) return done();
          header = buf.subarray(0, HEADER_LEN);
          if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Not a backup file made by this app (no HWPBK001 header)');
          chunkSize = header.readUInt32BE(40);
          if (!chunkSize || chunkSize > MAX_CHUNK) throw BAD();
          k = fileKey(key, header.subarray(8, 40));
          buf = buf.subarray(HEADER_LEN);
        }
        while (buf.length >= 5) {
          if (ended) throw BAD();
          const final = buf[0], len = buf.readUInt32BE(1);
          if (final > 1 || len > chunkSize) throw BAD();
          if (buf.length < 5 + len + TAG) break;
          const d = crypto.createDecipheriv('aes-256-gcm', k, nonce(n++, final === 1)); d.setAAD(header);
          d.setAuthTag(buf.subarray(5 + len, 5 + len + TAG));
          let plain;
          try { plain = Buffer.concat([d.update(buf.subarray(5, 5 + len)), d.final()]); } catch (e) { throw BAD(); }
          buf = buf.subarray(5 + len + TAG);
          if (plain.length) this.push(plain);
          if (final === 1) ended = true;
        }
        if (ended && buf.length) throw BAD();
        done();
      } catch (e) { done(e); }
    },
    flush(done) { done(ended && !buf.length ? null : BAD()); },
  });
}

// A fingerprint of BACKUP_KEY for the manifest: says which key a backup needs, reveals nothing of it
const keyId = key => crypto.createHash('sha256').update(Buffer.from(crypto.hkdfSync('sha256', key, '', 'hwp backup key id v1', 32))).digest('hex').slice(0, 16);
const manifestKey = key => Buffer.from(crypto.hkdfSync('sha256', key, '', 'hwp backup manifest v1', 32));
// Keys in a fixed order at every level, so the signature does not depend on how the JSON was written
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
function signManifest(key, m) { const { mac, ...rest } = m; return { ...rest, mac: crypto.createHmac('sha256', manifestKey(key)).update(canonical(rest)).digest('hex') }; }
function verifyManifest(key, m) {
  if (!m || typeof m.mac !== 'string') return false;
  const want = signManifest(key, m).mac;
  return want.length === m.mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m.mac));
}

module.exports = { encryptStream, decryptStream, keyId, signManifest, verifyManifest, HEADER_LEN, CHUNK };
