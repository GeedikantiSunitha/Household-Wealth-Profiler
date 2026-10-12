/* Encryption at rest for households, versions, audit entries and firm settings. This is the only
   module that uses keys.
   - AES-256-GCM with a random 12-byte IV per write, stored as base64(IV, 16-byte tag, ciphertext).
   - "enc:v1:" records are sealed with the master key (DATA_KEY) directly: everything written before
     tenancy. They still open as they are.
   - "enc:v2:" records are sealed with a key derived from the firm's own data key. Each firm's key
     is random and stored wrapped by the master key ("wk:v1:", envelope encryption): the master
     never touches records, one firm's key opens nothing of another firm's, and a firm's key can
     be retired on its own. Two keys are derived from it with distinct labels (HKDF-SHA256):
     "hwp record key v1" for sealing records and "hwp reference index v1" for the reference index,
     so neither use can learn anything about the other. The labels are part of the stored format.
   - Without a key (ALLOW_PLAINTEXT, local testing only) text is stored as it is, and text that was
     stored that way always opens as it is.
   The reference index: a keyed hash (HMAC-SHA256) of a client reference in its normalised form,
   with a key derived from the firm's data key, so the database can find a duplicate reference
   within a firm without holding the reference in clear. */
'use strict';
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const WRAP_PREFIX = 'wk:v1:';
const NO_KEY = 'Data is encrypted but DATA_KEY is not set';

function encrypt(key, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function decrypt(key, b64) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// The master sealer: seals v1 (used by the file store and by data written before tenancy)
function createSealer(key) {
  function seal(text) { return key ? PREFIX + encrypt(key, Buffer.from(text, 'utf8')) : text; }
  function open(text) {
    if (text.startsWith(PREFIX_V2)) throw new Error('This record is sealed with a firm key; open it through the firm');
    if (!text.startsWith(PREFIX)) return text;
    if (!key) throw new Error(NO_KEY);
    return decrypt(key, text.slice(PREFIX.length)).toString('utf8');
  }
  return { seal, open, key };
}

const derive = (firmKey, label) => Buffer.from(crypto.hkdfSync('sha256', firmKey, '', label, 32));
const recordKeyFor = firmKey => derive(firmKey, 'hwp record key v1');
const indexKeyFor = firmKey => derive(firmKey, 'hwp reference index v1');

// A firm's sealer: seals v2 with the firm's record key; opens v2, v1 (master) and plain text
function createFirmSealer({ master, firmKey }) {
  const recordKey = firmKey ? recordKeyFor(firmKey) : null;
  function seal(text) { return recordKey ? PREFIX_V2 + encrypt(recordKey, Buffer.from(text, 'utf8')) : text; }
  function open(text) {
    if (text.startsWith(PREFIX_V2)) { if (!recordKey) throw new Error(NO_KEY); return decrypt(recordKey, text.slice(PREFIX_V2.length)).toString('utf8'); }
    if (text.startsWith(PREFIX)) { if (!master) throw new Error(NO_KEY); return decrypt(master, text.slice(PREFIX.length)).toString('utf8'); }
    return text;
  }
  return { seal, open };
}

const newDataKey = () => crypto.randomBytes(32);
const wrapKey = (master, key) => WRAP_PREFIX + encrypt(master, key);
function unwrapKey(master, wrapped) {
  if (!wrapped.startsWith(WRAP_PREFIX)) throw new Error('Not a wrapped key');
  const key = decrypt(master, wrapped.slice(WRAP_PREFIX.length));
  if (key.length !== 32) throw new Error('Wrapped key has the wrong length');
  return key;
}

// A client reference in the one form it is compared in: compatibility-normalised (NFKC), trimmed,
// inner whitespace collapsed, upper case. Nothing (empty or missing) is null: no index.
function normaliseReference(ref) {
  if (ref === undefined || ref === null) return null;
  const s = String(ref).normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  return s || null;
}
function referenceIndex(indexKey, ref) {
  const n = normaliseReference(ref);
  return n === null ? null : crypto.createHmac('sha256', indexKey).update(n, 'utf8').digest('hex');
}

module.exports = { createSealer, createFirmSealer, newDataKey, wrapKey, unwrapKey, normaliseReference, referenceIndex, indexKeyFor, recordKeyFor, PREFIX, PREFIX_V2 };
