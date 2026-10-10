/* Sign-in with HTTP Basic (named users from AUTH_USERS, passwords hashed with scrypt).
   Must only be used over HTTPS: the browser sends the password with every request.
     authenticate(req)  { user } signed in | { locked: true } too many failures | null not signed in
   - Each client address gets 10 failed attempts; then it is locked out for 15 minutes, even with
     the right password. A lock that has run out starts the count again; a success clears it.
   - The address is the proxy's header when CLIENT_IP_HEADER is set, else the connection's.
   - A request without Basic credentials is not counted as a failure.
   - A successful login is remembered for 5 minutes (by a hash of the header), so the slow
     password check is not repeated on every request.
   Known limits, kept on purpose until sign-in is replaced (see docs/decisions): an unknown name
   is answered faster than a wrong password, and the two maps are never pruned. */
'use strict';
const crypto = require('crypto');

const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60e3;
const CACHE_MS = 5 * 60e3;

function createBasicAuth({ users, clientIpHeader = '', now = Date.now }) {
  const failures = new Map(); // ip -> {n, until}
  const authCache = new Map(); // sha256(header) -> {user, exp}

  function authenticate(req) {
    const ip = (clientIpHeader && req.headers[clientIpHeader]) || req.socket.remoteAddress || '';
    const f = failures.get(ip);
    if (f && f.until > now()) return { locked: true };
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return null;
    const key = crypto.createHash('sha256').update(h).digest('hex');
    const hit = authCache.get(key);
    if (hit && hit.exp > now()) return { user: hit.user };
    let decoded = '';
    try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { return null; }
    const i = decoded.indexOf(':');
    const name = decoded.slice(0, i), pass = decoded.slice(i + 1);
    const u = users.get(name);
    const ok = !!u && i > 0 && crypto.timingSafeEqual(crypto.scryptSync(pass, u.salt, 64), u.hash);
    if (!ok) {
      const expired = f && f.until && f.until <= now();
      const n = (f && !expired ? f.n : 0) + 1;
      failures.set(ip, { n, until: n >= MAX_FAILURES ? now() + LOCK_MS : 0 });
      return null;
    }
    failures.delete(ip);
    authCache.set(key, { user: name, exp: now() + CACHE_MS });
    return { user: name };
  }

  return { authenticate };
}

// An AUTH_USERS entry: name:salt:hash (16-byte random salt and 64-byte scrypt hash, both hex)
function hashPassword(name, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${name}:${salt}:${crypto.scryptSync(pass, salt, 64).toString('hex')}`;
}

module.exports = { createBasicAuth, hashPassword, MAX_FAILURES, LOCK_MS, CACHE_MS };
