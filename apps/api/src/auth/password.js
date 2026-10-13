/* Passwords for the app's own sign-in (Phase 2).
   - scrypt at the parameters OWASP recommends today: N = 2^17, r = 8, p = 1, a 16-byte random
     salt and a 64-byte key. One hash costs about 128 MiB and a tenth of a second, which is the
     point: a stolen table is slow to attack. Stored as "scrypt$N$r$p$salt$hash" (base64url), so
     the parameters can be raised later and old hashes still verify. Hashing is asynchronous and
     does not block the server.
   - verifyPassword compares in constant time. dummyVerify runs a real scrypt at the same
     parameters for an unknown or inactive account, so the time a sign-in takes does not tell
     accounts apart.
   - checkPolicy: 12 to 200 characters, any characters. Length is what matters; composition rules
     are not applied (NCSC and NIST guidance).
   - delayAfter(failures): the progressive delay before an account is tried again, replacing a
     hard lockout: nothing for the first two failures, then 1, 2, 4 ... seconds, capped at 60.
   - breachedCount: the Have I Been Pwned range API by k-anonymity. Only the first five hex
     characters of the SHA-1 leave the server; the rest is matched locally. A failure (no network,
     an error, a slow answer) returns null and is logged; it never blocks a sign-in or a change. */
'use strict';
const crypto = require('crypto');

const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1, keylen: 64, saltBytes: 16 });
const MAXMEM = 160 * 1024 * 1024; // 128 * N * r = 128 MiB, with room
const MIN_LENGTH = 12, MAX_LENGTH = 200;
const RANGE_URL = 'https://api.pwnedpasswords.com/range/';

const scrypt = (password, salt, { N, r, p, keylen }) => new Promise((ok, no) =>
  crypto.scrypt(Buffer.from(String(password), 'utf8'), salt, keylen, { N, r, p, maxmem: MAXMEM }, (e, key) => e ? no(e) : ok(key)));

async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// The stored hash's parts, or null when it is not one of ours
function parse(stored) {
  if (typeof stored !== 'string') return null;
  const [algo, N, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return null;
  const params = { N: +N, r: +r, p: +p, keylen: Buffer.from(hash, 'base64url').length };
  if (![params.N, params.r, params.p].every(n => Number.isInteger(n) && n > 0) || params.keylen < 32) return null;
  return { params, salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') };
}

async function verifyPassword(stored, password) {
  const parts = parse(stored);
  if (!parts) return false;
  try {
    const key = await scrypt(password, parts.salt, parts.params);
    return key.length === parts.hash.length && crypto.timingSafeEqual(key, parts.hash);
  } catch (e) { return false; }
}

// For an account that does not exist or cannot sign in: the same work as a real check, never true
let dummyHash = null;
const dummyHashString = async () => dummyHash || (dummyHash = await hashPassword(crypto.randomBytes(24).toString('base64url')));
async function dummyVerify(password) {
  await verifyPassword(await dummyHashString(), password);
  return false;
}

function checkPolicy(password) {
  const s = typeof password === 'string' ? password : '';
  if (s.trim().length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters`;
  if (s.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters`;
  return null;
}

const delayAfter = failures => failures < 3 ? 0 : Math.min(2 ** (failures - 3), 60);

async function breachedCount(password, { fetch = globalThis.fetch, timeoutMs = 5000, log = m => console.error(new Date().toISOString(), m) } = {}) {
  const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5), suffix = sha1.slice(5);
  let timer;
  try {
    const r = await Promise.race([
      fetch(RANGE_URL + prefix, { headers: { 'Add-Padding': 'true', 'User-Agent': 'household-wealth-profiler' } }),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    if (!r.ok) throw new Error(`status ${r.status}`);
    for (const line of (await r.text()).split('\n')) {
      const [rest, count] = line.trim().split(':');
      if (rest === suffix) return +count || 0;
    }
    return 0;
  } catch (e) {
    log(`breached-password check skipped: ${e.message}`);
    return null;
  } finally { clearTimeout(timer); }
}

module.exports = { hashPassword, verifyPassword, dummyVerify, dummyHashString, checkPolicy, delayAfter, breachedCount, SCRYPT, MIN_LENGTH, MAX_LENGTH };
