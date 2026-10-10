/* Encryption at rest for households, versions and audit entries.
   AES-256-GCM with a random 12-byte IV per write, stored as "enc:v1:" + base64(IV, 16-byte tag,
   ciphertext). Without a key, text is stored as it is (ALLOW_PLAINTEXT, local testing only), and
   text that was stored that way always opens as it is. This is the only module that uses the key. */
'use strict';
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function createSealer(key) {
  function seal(text) {
    if (!key) return text;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }
  function open(text) {
    if (!text.startsWith(PREFIX)) return text;
    if (!key) throw new Error('Data is encrypted but DATA_KEY is not set');
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
  return { seal, open };
}

module.exports = { createSealer, PREFIX };
