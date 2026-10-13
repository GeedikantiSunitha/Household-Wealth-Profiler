/* Server-side sessions in a cookie (Phase 2).
   - The id is 32 random bytes; the store keeps only its SHA-256, so a copy of the table signs
     nobody in. The cookie is HttpOnly, SameSite=Strict, Path=/ and, in production, Secure with the
     __Host- prefix (which a browser accepts only over HTTPS for this exact host); in development
     over plain HTTP the name has no prefix and no Secure flag.
   - Two limits: idle (no request for 30 minutes, by default) and absolute (12 hours from sign-in,
     however active). Rotation (a new id at each stage change and firm switch) keeps the original
     absolute limit. Activity is recorded at most once a minute.
   - A session ends on the next request when it is revoked, when the account is deactivated, or
     when the membership in its firm is gone: not at the next sign-in.
   - The CSRF token is derived from the session's hash with a server secret, so a token belongs
     to one session and changes with rotation. The secret is derived from DATA_KEY with its own
     label (no extra secret to manage); without a key it is random for the process.
   - stage 'password' means the second step is still to do: the pipeline lets such a session reach
     only the second-step and sign-out routes. */
'use strict';
const crypto = require('crypto');

const COOKIE_SECURE = '__Host-hwp_session', COOKIE_PLAIN = 'hwp_session';
const TOUCH_MS = 60e3;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

const sessionSecretFrom = key => key ? Buffer.from(crypto.hkdfSync('sha256', key, '', 'hwp session v1', 32)) : crypto.randomBytes(32);
const hashId = id => crypto.createHash('sha256').update(id).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

function createSessions({ store, secret, idleMs = 30 * 60e3, absoluteMs = 12 * 3600e3, secure = true, now = Date.now }) {
  const name = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  const attrs = `Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict`;
  const cookie = (id, expiresAt) => `${name}=${id}; Max-Age=${Math.max(0, Math.floor((expiresAt - now()) / 1000))}; ${attrs}`;
  const csrfFor = idHash => crypto.createHmac('sha256', secret).update('csrf:' + idHash).digest('base64url');
  const at = () => new Date(now());

  async function issue({ userId, firmId = null, stage, ip = '', userAgent = '' }) {
    const id = crypto.randomBytes(32).toString('base64url'), idHash = hashId(id);
    const expiresAt = new Date(now() + absoluteMs);
    await store.createSession({ idHash, userId, firmId, stage, expiresAt, ip, userAgent: String(userAgent).slice(0, 300), at: at() });
    return { id, idHash, cookie: cookie(id, expiresAt.getTime()), csrf: csrfFor(idHash), expiresAt };
  }

  // The session a request carries, with its user, firm role and CSRF token; null when there is none or it has ended
  async function resolve(req) {
    const id = parseCookies(req.headers.cookie)[name];
    if (!id || !ID_RE.test(id)) return null;
    const idHash = hashId(id);
    const s = await store.findSession(idHash);
    if (!s || s.revoked_at) return null;
    const t = now();
    if (new Date(s.expires_at).getTime() <= t || new Date(s.last_seen_at).getTime() + idleMs <= t) { await store.revokeSession(idHash, at()); return null; }
    const user = await store.findUser(s.user_id);
    if (!user || !user.active) { await store.revokeSession(idHash, at()); return null; }
    let role = null, firmName = null;
    if (s.firm_id) {
      const m = (await store.memberships(s.user_id)).find(x => x.firmId === s.firm_id);
      if (!m) { await store.revokeSession(idHash, at()); return null; }
      role = m.role; firmName = m.firmName;
    }
    if (t - new Date(s.last_seen_at).getTime() >= TOUCH_MS) await store.touchSession(idHash, at());
    return { session: s, user, role, firmName, csrf: csrfFor(idHash) };
  }

  async function rotate(session, { stage, firmId } = {}) {
    const id = crypto.randomBytes(32).toString('base64url'), idHash = hashId(id);
    const row = await store.rotateSession(session.id_hash, { idHash, stage, firmId, at: at() });
    return { id, idHash, cookie: cookie(id, new Date(row.expires_at).getTime()), csrf: csrfFor(idHash) };
  }

  const clearCookie = () => `${name}=; Max-Age=0; ${attrs}`;
  const revoke = async ({ session }) => { await store.revokeSession(session.id_hash, at()); return clearCookie(); };
  const revokeAll = (userId, { except = null } = {}) => store.revokeAllSessions(userId, { except: except ? except.id_hash : null, at: at() });

  return { cookieName: name, issue, resolve, rotate, revoke, revokeAll, clearCookie, csrfFor };
}

module.exports = { createSessions, sessionSecretFrom, parseCookies, COOKIE_SECURE, COOKIE_PLAIN, TOUCH_MS };
