/* The sign-in store (PostgreSQL only): accounts, their sign-in state and the auth event log, in
   the tables of migration 0010. Every call runs in one transaction with app.auth set, which is
   what the row-security policies require of the app role; outside such a transaction the app role
   sees none of these rows. Emails are matched in their normalised form (trimmed, lower case).
   Sessions (2.3) and the authenticator (2.5) are kept here too. */
'use strict';
const { tx } = require('../db/pool.js');
const { delayAfter } = require('./password.js');

const normaliseEmail = e => String(e || '').trim().toLowerCase();
const USER_COLUMNS = 'id, email, name, active, password_hash, password_set_at, totp_secret, totp_confirmed_at, totp_last_step, failed_attempts, not_before, last_sign_in_at, reenrol';

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
  };
}

module.exports = { createAuthStore, normaliseEmail };
