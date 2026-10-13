/* The sign-in store (PostgreSQL only): accounts, their sign-in state and the auth event log, in
   the tables of migration 0010. Every call runs in one transaction with app.auth set, which is
   what the row-security policies require of the app role; outside such a transaction the app role
   sees none of these rows. Emails are matched in their normalised form (trimmed, lower case).
   Sessions (2.3) and the authenticator (2.5) are kept here too. */
'use strict';
const { tx } = require('../db/pool.js');
const { delayAfter } = require('./password.js');

const normaliseEmail = e => String(e || '').trim().toLowerCase();
const USER_COLUMNS = 'id, email, name, active, password_hash, password_set_at, totp_secret, totp_pending, totp_confirmed_at, totp_last_step, failed_attempts, not_before, last_sign_in_at, reenrol';

function createAuthStore({ pool, now = () => new Date() }) {
  const withAuth = fn => tx(pool, async c => { await c.query("select set_config('app.auth', 'on', true)"); return fn(c); });
  const one = r => r.rows[0] || null;

  return {
    withAuth,
    normaliseEmail,

    findUserByEmail: email => withAuth(async c => one(await c.query(`select ${USER_COLUMNS} from users where email = $1`, [normaliseEmail(email)]))),
    findUser: id => withAuth(async c => one(await c.query(`select ${USER_COLUMNS} from users where id = $1`, [id]))),
    // Active memberships with the firm's name, for the firm picker
    memberships: userId => withAuth(async c => (await c.query(
      `select m.firm_id as "firmId", f.name as "firmName", m.role from memberships m join firms f on f.id = m.firm_id where m.user_id = $1 and m.active and f.status = 'active' order by f.name`, [userId])).rows),

    // One more failure: the count goes up and the account is not tried again before the delay has passed
    recordFailure: userId => withAuth(async c => {
      const r = one(await c.query('update users set failed_attempts = failed_attempts + 1 where id = $1 returning failed_attempts', [userId]));
      const delay = delayAfter(r.failed_attempts);
      await c.query('update users set not_before = $2 where id = $1', [userId, delay ? new Date(now().getTime() + delay * 1000) : null]);
      return { failures: r.failed_attempts, delay };
    }),
    recordSuccess: userId => withAuth(c => c.query('update users set failed_attempts = 0, not_before = null, last_sign_in_at = $2 where id = $1', [userId, now()])),
    setPassword: (userId, hash) => withAuth(c => c.query('update users set password_hash = $2, password_set_at = $3 where id = $1', [userId, hash, now()])),

    event: ({ userId = null, email = '', event, outcome = '', ip = '', userAgent = '', detail = '' }) => withAuth(c =>
      c.query('insert into auth_events (user_id, email, event, outcome, ip, user_agent, detail) values ($1, $2, $3, $4, $5, $6, $7)', [userId, normaliseEmail(email), event, outcome, ip, String(userAgent).slice(0, 300), detail])),
    events: userId => withAuth(async c => (await c.query('select at, event, outcome, ip, detail from auth_events where user_id = $1 order by id', [userId])).rows),

    // The authenticator: a pending secret until its first code confirms it; the last accepted step for replay protection
    setPendingTotp: (userId, sealed) => withAuth(c => c.query('update users set totp_pending = $2 where id = $1', [userId, sealed])),
    confirmTotp: (userId, { sealed, step }) => withAuth(c => c.query('update users set totp_secret = $2, totp_pending = null, totp_confirmed_at = $3, totp_last_step = $4, reenrol = false where id = $1', [userId, sealed, now(), step])),
    setTotpStep: (userId, step) => withAuth(c => c.query('update users set totp_last_step = greatest(totp_last_step, $2) where id = $1', [userId, step])),
    // After a recovery-code sign-in: the authenticator no longer counts and a new one must be set up
    clearTotp: userId => withAuth(c => c.query('update users set totp_confirmed_at = null, reenrol = true where id = $1', [userId])),
    replaceRecoveryCodes: (userId, hashes) => withAuth(async c => {
      await c.query('update recovery_codes set used_at = $2 where user_id = $1 and used_at is null', [userId, now()]);
      for (const h of hashes) await c.query('insert into recovery_codes (user_id, code_hash) values ($1, $2)', [userId, h]);
    }),
    unusedRecoveryCodes: userId => withAuth(async c => (await c.query('select id, code_hash from recovery_codes where user_id = $1 and used_at is null order by created_at', [userId])).rows),
    useRecoveryCode: id => withAuth(c => c.query('update recovery_codes set used_at = $2 where id = $1 and used_at is null', [id, now()])),

    // Sessions (auth/sessions.js decides the rules; this is only the rows)
    createSession: ({ idHash, userId, firmId = null, stage, expiresAt, ip = '', userAgent = '', at }) => withAuth(async c => one(await c.query(
      'insert into sessions (id_hash, user_id, firm_id, stage, created_at, last_seen_at, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5, $5, $6, $7, $8) returning *',
      [idHash, userId, firmId, stage, at || now(), expiresAt, ip, userAgent]))),
    findSession: idHash => withAuth(async c => one(await c.query('select * from sessions where id_hash = $1', [idHash]))),
    touchSession: (idHash, at) => withAuth(c => c.query('update sessions set last_seen_at = $2 where id_hash = $1', [idHash, at || now()])),
    revokeSession: (idHash, at) => withAuth(c => c.query('update sessions set revoked_at = $2 where id_hash = $1 and revoked_at is null', [idHash, at || now()])),
    // A new id for the same sign-in: the old row is ended and the new one keeps the absolute limit, address and agent
    rotateSession: (oldHash, { idHash, stage, firmId, at }) => withAuth(async c => {
      const old = one(await c.query('update sessions set revoked_at = $2 where id_hash = $1 and revoked_at is null returning *', [oldHash, at || now()]));
      if (!old) throw Object.assign(new Error('Session has ended'), { status: 401, code: 'sign_in_required' });
      return one(await c.query(
        'insert into sessions (id_hash, user_id, firm_id, stage, created_at, last_seen_at, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5, $5, $6, $7, $8) returning *',
        [idHash, old.user_id, firmId === undefined ? old.firm_id : firmId, stage || old.stage, at || now(), old.expires_at, old.ip, old.user_agent]));
    }),
    revokeAllSessions: (userId, { except = null, at } = {}) => withAuth(async c =>
      (await c.query('update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null and ($3::text is null or id_hash <> $3)', [userId, at || now(), except])).rowCount),
    activeSessions: userId => withAuth(async c => (await c.query('select id_hash, firm_id, stage, created_at, last_seen_at, expires_at, ip, user_agent from sessions where user_id = $1 and revoked_at is null and expires_at > $2 order by last_seen_at desc', [userId, now()])).rows),
  };
}

module.exports = { createAuthStore, normaliseEmail };
