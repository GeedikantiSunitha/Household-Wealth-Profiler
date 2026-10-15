/* Time-based one-time codes for the second step at sign-in (RFC 6238 over RFC 4226): HMAC-SHA1,
   6 digits, 30-second steps, which every authenticator app supports. A code is accepted for the
   current step and one step either side (clock drift), compared in constant time, and never twice:
   the caller keeps the last accepted step per account and a code at or before it is refused.
   Secrets are 20 random bytes, shown once as base32 and as an otpauth URI for the app to scan.
   Recovery codes: ten random codes shown once, stored hashed by the caller, each usable once. */
'use strict';
const crypto = require('crypto');

const STEP_SECONDS = 30, DIGITS = 6, DRIFT = 1;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o/1/l: typed from paper

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

const generateSecret = () => crypto.randomBytes(20);

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// { ok: true, step } for a code at the current step or one either side and after lastStep; else { ok: false }
function verifyCode(secret, code, { nowMs = Date.now(), lastStep = 0 } = {}) {
  if (typeof code !== 'string') return { ok: false };
  const digits = code.replace(/ /g, ''); // spaces as the app shows them; nothing else
  if (!/^\d{6}$/.test(digits)) return { ok: false };
  const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
  let accepted = null;
  for (let step = current - DRIFT; step <= current + DRIFT; step++) {
    // every candidate is compared, so the time taken does not depend on which one matched
    const match = crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(digits));
    if (match && step > lastStep && accepted === null) accepted = step;
  }
  return accepted === null ? { ok: false } : { ok: true, step: accepted };
}

const otpauthUri = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

function newRecoveryCodes(n = 10) {
  const out = new Set();
  while (out.size < n) {
    const bytes = crypto.randomBytes(10);
    const s = Array.from(bytes, b => RECOVERY_ALPHABET[b % 32]).join('');
    out.add(s.slice(0, 5) + '-' + s.slice(5));
  }
  return [...out];
}
function normaliseRecoveryCode(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.length === 10 ? s.slice(0, 5) + '-' + s.slice(5) : s ? s : '';
}

module.exports = { codeAt, verifyCode, generateSecret, otpauthUri, base32Encode, base32Decode, newRecoveryCodes, normaliseRecoveryCode, STEP_SECONDS, DIGITS, DRIFT };
