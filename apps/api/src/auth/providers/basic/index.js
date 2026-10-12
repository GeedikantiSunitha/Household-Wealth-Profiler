/* Sign-in with HTTP Basic (named users from AUTH_USERS, passwords hashed with scrypt).
   Must only be used over HTTPS: the browser sends the password with every request.
     authenticate(req)  { user } signed in | { locked: true } too many failures | null not signed in
   - Each client address gets 10 failed attempts; then it is locked out for 15 minutes, even with
     the right password. A lock that has run out starts the count again; a success clears it.
   - The address is the proxy's header when CLIENT_IP_HEADER is set, else the connection's.
   - A request without Basic credentials is not counted as a failure.
   - A successful login is remembered for 5 minutes (by a hash of the header), so the slow
     password check is not repeated on every request.
   - Failures only count within the 15-minute window; an unknown name costs the same password
     check as a wrong password (so replies do not reveal which names exist); both maps are pruned
     once a minute and capped, so they cannot grow without limit. */
'use strict';
const crypto = require('crypto');

const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60e3;
const CACHE_MS = 5 * 60e3;
const PRUNE_MS = 60e3;
const MAX_ENTRIES = 10000;

// The password check run for an unknown name, so it takes as long as a wrong password
let dummyUser = null;
const dummy = () => dummyUser || (dummyUser = { salt: '0'.repeat(32), hash: crypto.scryptSync('not a password', '0'.repeat(32), 64) });

function createBasicAuth({ users, clientIpHeader = '', now = Date.now }) {
  const failures = new Map(); // ip -> {n, until, last}
  const authCache = new Map(); // sha256(header) -> {user, exp}
  let lastPrune = 0;

  function prune(t) {
    if (t - lastPrune < PRUNE_MS) return;
    lastPrune = t;
    for (const [k, f] of failures) if (f.until ? f.until <= t : f.last + LOCK_MS <= t) failures.delete(k);
    for (const [k, c] of authCache) if (c.exp <= t) authCache.delete(k);
  }
  // Maps keep insertion order, so the first key is the oldest
  const cap = m => { while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value); };

  function authenticate(req) {
    const t = now();
    prune(t);
    const ip = (clientIpHeader && req.headers[clientIpHeader]) || req.socket.remoteAddress || '';
    const f = failures.get(ip);
    if (f && f.until > t) return { locked: true };
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return null;
    const key = crypto.createHash('sha256').update(h).digest('hex');
    const hit = authCache.get(key);
    if (hit && hit.exp > t) return { user: hit.user };
    let decoded = '';
    try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { return null; }
    const i = decoded.indexOf(':');
    const name = decoded.slice(0, i), pass = decoded.slice(i + 1);
    const known = users.get(name);
    const u = known || dummy();
    const hash = crypto.scryptSync(pass, u.salt, 64);
    const ok = !!known && i > 0 && crypto.timingSafeEqual(hash, u.hash);
    if (!ok) {
      // A count carries on only while the failures are recent and no lock has run out
      const recent = f && !f.until && f.last + LOCK_MS > t;
      const n = (recent ? f.n : 0) + 1;
      failures.set(ip, { n, until: n >= MAX_FAILURES ? t + LOCK_MS : 0, last: t });
      cap(failures);
      return null;
    }
    failures.delete(ip);
    authCache.set(key, { user: name, exp: t + CACHE_MS });
    cap(authCache);
    return { user: name };
  }

  const stats = () => ({ failures: failures.size, cached: authCache.size });

  return { authenticate, stats };
}

// An AUTH_USERS entry: name:salt:hash (16-byte random salt and 64-byte scrypt hash, both hex)
function hashPassword(name, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${name}:${salt}:${crypto.scryptSync(pass, salt, 64).toString('hex')}`;
}

module.exports = { createBasicAuth, hashPassword, MAX_FAILURES, LOCK_MS, CACHE_MS };
