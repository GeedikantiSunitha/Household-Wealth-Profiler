/* A per-address limit for the sign-in routes: at most `max` attempts in a window, whatever the
   outcome, so a flood from one address (guessing passwords or codes across many accounts) is cut
   off while the account-level progressive delay deals with one account. The address is the
   proxy's header when CLIENT_IP_HEADER is set, else the connection's. Entries are pruned as they
   expire and capped, so the map cannot grow without limit. */
'use strict';

const AUTH_LIMIT = Object.freeze({ max: 20, windowMs: 15 * 60e3 });
const PRUNE_MS = 60e3;

const ipOf = (req, clientIpHeader = '') => String((clientIpHeader && req.headers[clientIpHeader]) || (req.socket && req.socket.remoteAddress) || '');

function createLimiter({ max, windowMs, now = Date.now, maxEntries = 10000 }) {
  const hits = new Map(); // key -> { n, start }
  let lastPrune = 0;
  function prune(t) {
    if (t - lastPrune < PRUNE_MS) return;
    lastPrune = t;
    for (const [k, h] of hits) if (h.start + windowMs <= t) hits.delete(k);
    while (hits.size > maxEntries) hits.delete(hits.keys().next().value);
  }
  // Counts one attempt; { allowed: true } or { allowed: false, retryAfter: seconds }
  function hit(key) {
    const t = now();
    prune(t);
    let h = hits.get(key);
    if (!h || h.start + windowMs <= t) { h = { n: 0, start: t }; hits.set(key, h); }
    h.n++;
    return h.n > max ? { allowed: false, retryAfter: Math.ceil((h.start + windowMs - t) / 1000) } : { allowed: true };
  }
  return { hit, size: () => hits.size };
}

module.exports = { createLimiter, ipOf, AUTH_LIMIT };
