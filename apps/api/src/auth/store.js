/* The sign-in store (PostgreSQL only): accounts, their sign-in state and the auth event log, in
   the tables of migration 0010. Every call runs in one transaction with app.auth set, which is
   what the row-security policies require of the app role; outside such a transaction the app role
   sees none of these rows. Emails are matched in their normalised form (trimmed, lower case).
   Sessions (2.3) and the authenticator (2.5) are kept here too. Team management (Phase 3) runs in a
   transaction that also says which firm it works in (withFirm): the policies of migration 0014 let a
   membership be changed only for that firm. */
'use strict';
const crypto = require('crypto');
const { tx } = require('../db/pool.js');
const { delayAfter } = require('./password.js');

const normaliseEmail = e => String(e || '').trim().toLowerCase();
const USER_COLUMNS = 'id, email, name, active, password_hash, password_set_at, totp_secret, totp_pending, totp_confirmed_at, totp_last_step, failed_attempts, not_before, last_sign_in_at, reenrol';

function createAuthStore({ pool, now = () => new Date() }) {
  const withAuth = fn => tx(pool, async c => { await c.query("select set_config('app.auth', 'on', true)"); return fn(c); });
  // Sign-in rights plus the firm the work is for: what membership changes (migration 0014) require
  const withFirm = (firmId, fn) => tx(pool, async c => { await c.query("select set_config('app.auth', 'on', true)"); await c.query("select set_config('app.firm_id', $1, true)", [firmId]); return fn(c); });
  const one = r => r.rows[0] || null;
  const refuse = (status, code, message) => Object.assign(new Error(message), { status, code });
  const rolesOf = m => [m.role, ...(m.extra_roles || m.extraRoles || [])];
  const withRoles = ({ extraRoles, ...m }) => ({ ...m, roles: [m.role, ...(extraRoles || [])] });

  return {
    withAuth,
    withFirm,
    normaliseEmail,

    findUserByEmail: email => withAuth(async c => one(await c.query(`select ${USER_COLUMNS} from users where email = $1`, [normaliseEmail(email)]))),
    findUser: id => withAuth(async c => one(await c.query(`select ${USER_COLUMNS} from users where id = $1`, [id]))),
    // Active, accepted memberships with the firm's name, for the firm picker and for the session: role is the
    // primary role and roles every role (the primary one first). A pending or declined invitation is not one.
    memberships: userId => withAuth(async c => (await c.query(
      `select m.firm_id as "firmId", f.name as "firmName", m.role, m.extra_roles as "extraRoles" from memberships m join firms f on f.id = m.firm_id
        where m.user_id = $1 and m.active and m.accepted_at is not null and f.status = 'active' order by f.name`, [userId])).rows.map(withRoles)),
    // Invitations to a firm that the person has not answered yet (an existing account added to another firm)
    pendingInvitations: userId => withAuth(async c => (await c.query(
      `select m.firm_id as "firmId", f.name as "firmName", m.role, m.extra_roles as "extraRoles", m.created_at as "invitedAt" from memberships m join firms f on f.id = m.firm_id
        where m.user_id = $1 and m.active and m.accepted_at is null and m.declined_at is null and f.status = 'active' order by f.name`, [userId])).rows.map(withRoles)),
    // The person's own answer to an invitation. The firm is named in the transaction (the update policy of migration 0014
    // needs it) and the row must be this person's pending invitation: nothing else can be answered through here.
    respondToInvitation: (userId, firmId, accept) => withFirm(firmId, async c => {
      const m = one(await c.query(
        'select role, extra_roles from memberships where user_id = $1 and firm_id = $2 and active and accepted_at is null and declined_at is null for update', [userId, firmId]));
      if (!m) throw refuse(404, 'not_found', 'There is no invitation from that firm to answer');
      if (accept) await c.query('update memberships set accepted_at = $3 where user_id = $1 and firm_id = $2', [userId, firmId, now()]);
      else await c.query('update memberships set declined_at = $3, active = false where user_id = $1 and firm_id = $2', [userId, firmId, now()]);
      const who = one(await c.query('select email from users where id = $1', [userId]));
      await c.query('insert into auth_events (user_id, email, event, outcome, detail) values ($1, $2, $3, $4, $5)',
        [userId, who ? who.email : '', accept ? 'invitation_accepted' : 'invitation_declined', 'ok', `${rolesOf(m).join('+')} in ${firmId}`]);
      return { roles: rolesOf(m) };
    }),

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

    // One-time links (password reset, invitation): the token leaves as random bytes and is kept as a hash;
    // issuing one invalidates older unused ones of that purpose; consuming is single use and within the time
    issueToken: (userId, purpose, ttlMs) => withAuth(async c => {
      const token = crypto.randomBytes(32).toString('base64url');
      await c.query('update one_time_tokens set used_at = $3 where user_id = $1 and purpose = $2 and used_at is null', [userId, purpose, now()]);
      await c.query('insert into one_time_tokens (user_id, purpose, token_hash, created_at, expires_at) values ($1, $2, $3, $4, $5)', [userId, purpose, crypto.createHash('sha256').update(token).digest('hex'), now(), new Date(now().getTime() + ttlMs)]);
      return { token };
    }),
    consumeToken: (token, purpose) => withAuth(async c => {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const r = one(await c.query('update one_time_tokens set used_at = $3 where token_hash = $1 and purpose = $2 and used_at is null and expires_at > $3 returning user_id', [crypto.createHash('sha256').update(token).digest('hex'), purpose, now()]));
      return r ? one(await c.query(`select ${USER_COLUMNS} from users where id = $1`, [r.user_id])) : null;
    }),
    // An account with a membership, made or found (migration 0011 lets the app role do this within sign-in)
    ensureUser: ({ email, name, firmId, role }) => withAuth(async c => {
      const firm = one(await c.query('select name from firms where id = $1', [firmId]));
      if (!firm) throw Object.assign(new Error('Unknown firm'), { status: 400, code: 'bad_request' });
      let u = one(await c.query('select id from users where email = $1', [normaliseEmail(email)]));
      const created = !u;
      if (created) u = one(await c.query('insert into users (email, name) values ($1, $2) returning id', [normaliseEmail(email), name]));
      // an existing membership is left as it is: roles change through RBAC (Phase 3), never through an invitation
      await c.query('insert into memberships (user_id, firm_id, role) values ($1, $2, $3) on conflict (user_id, firm_id) do nothing', [u.id, firmId, role]);
      return { userId: u.id, created, firmName: firm.name };
    }),
    createAccessRequest: ({ name, email, firm = '', note = '', ip = '' }) => withAuth(async c => one(await c.query(
      'insert into access_requests (name, email, firm_name, note, ip, created_at) values ($1, $2, $3, $4, $5, $6) returning id', [name, normaliseEmail(email), firm, note, ip, now()]))),

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

    // ---- Team management (Phase 3). The services decide who may call these; the rules below hold whoever does. ----
    // A firm's team with each person's roles and sign-in state, and the seats in use. Invitations hold a seat.
    // invitation is 'pending' for an existing account that has not yet accepted, 'declined' when it said no.
    members: firmId => withAuth(async c => (await c.query(
      `select u.id as "userId", u.email, u.name, m.role, m.extra_roles as "extraRoles", m.active, m.created_at as "createdAt", (u.password_hash is not null) as "hasPassword",
              (u.totp_confirmed_at is not null) as mfa, u.last_sign_in_at as "lastSignInAt", m.accepted_at as "acceptedAt", m.declined_at as "declinedAt"
         from memberships m join users u on u.id = m.user_id where m.firm_id = $1 order by lower(u.name), u.email`, [firmId])).rows
      .map(({ acceptedAt, declinedAt, ...m }) => ({ ...withRoles(m), invitation: declinedAt ? 'declined' : acceptedAt ? null : 'pending' }))),
    seats: firmId => withAuth(async c => one(await c.query(
      'select f.seats, (select count(*)::int from memberships m where m.firm_id = f.id and m.active) as used from firms f where f.id = $1', [firmId]))),

    // Adds someone to the firm's team. A new email gets an account and is on the team at once (they accept by
    // using the invitation link). An email that already has an account is added as a PENDING membership: it gives
    // no access until that person accepts at their next sign-in. The firm row is locked while the seats are counted,
    // so two invitations at once cannot both take the last seat. Refused: 409 already_member (this firm only:
    // nothing is said about other firms), 402 seats_full. Someone who declined earlier can be invited again.
    addMember: ({ email, name, firmId, roles }) => withFirm(firmId, async c => {
      const firm = one(await c.query('select id, name, seats from firms where id = $1 for update', [firmId]));
      if (!firm) throw refuse(400, 'bad_request', 'Unknown firm');
      let u = one(await c.query('select id, (password_hash is not null) as has_password from users where email = $1', [normaliseEmail(email)]));
      const had = u && one(await c.query('select declined_at from memberships where user_id = $1 and firm_id = $2', [u.id, firmId]));
      if (had && !had.declined_at) throw refuse(409, 'already_member', 'That person is already on the team. If they were deactivated, reactivate them instead.');
      const used = (await c.query('select count(*)::int n from memberships where firm_id = $1 and active', [firmId])).rows[0].n;
      if (used >= firm.seats) throw refuse(402, 'seats_full', `All ${firm.seats} seats are in use. Deactivate someone, or ask for more seats.`);
      const created = !u;
      if (created) u = one(await c.query('insert into users (email, name) values ($1, $2) returning id', [normaliseEmail(email), name]));
      const pending = !created;
      if (had) await c.query('update memberships set role = $3, extra_roles = $4, active = true, accepted_at = null, declined_at = null where user_id = $1 and firm_id = $2', [u.id, firmId, roles[0], roles.slice(1)]);
      else await c.query('insert into memberships (user_id, firm_id, role, extra_roles, accepted_at) values ($1, $2, $3, $4, $5)', [u.id, firmId, roles[0], roles.slice(1), pending ? null : now()]);
      return { userId: u.id, created, firmName: firm.name, hasPassword: !created && u.has_password, pending };
    }),

    // Changes a member's roles and/or active flag. All the firm's memberships are locked first, so two
    // administrators acting at once see each other: the firm can never be left with no active administrator
    // who has accepted (409 last_admin), and a reactivation needs a free seat (402 seats_full). Reactivating
    // someone who declined invites them again. Deactivating ends that person's sessions in this firm in the
    // same transaction. Every change is an auth event naming who made it.
    changeMember: (firmId, userId, { roles, active }, { by = '' } = {}) => withFirm(firmId, async c => {
      const rows = (await c.query('select user_id, role, extra_roles, active, accepted_at, declined_at from memberships where firm_id = $1 for update', [firmId])).rows;
      const target = rows.find(r => r.user_id === userId);
      if (!target) throw refuse(404, 'not_found', 'No such person on this team');
      const before = { roles: rolesOf(target), active: target.active };
      const next = { roles: roles === undefined ? before.roles : roles, active: active === undefined ? before.active : active };
      if (next.active === before.active && next.roles.join() === before.roles.join()) return { userId, ...next, changed: false };
      const standing = r => r.active && r.accepted_at && rolesOf(r).includes('admin');
      const admins = rows.map(r => (r.user_id === userId ? { ...r, role: next.roles[0], extra_roles: next.roles.slice(1), active: next.active } : r)).filter(standing).length;
      if (!admins) throw refuse(409, 'last_admin', 'The firm must keep at least one active administrator.');
      if (!target.active && next.active) {
        const { seats } = one(await c.query('select seats from firms where id = $1 for update', [firmId]));
        if (rows.filter(r => r.active).length >= seats) throw refuse(402, 'seats_full', `All ${seats} seats are in use. Deactivate someone, or ask for more seats.`);
      }
      const again = !target.active && next.active && target.declined_at; // reactivating a declined invitation invites again
      await c.query('update memberships set role = $3, extra_roles = $4, active = $5, accepted_at = $6, declined_at = $7 where firm_id = $1 and user_id = $2',
        [firmId, userId, next.roles[0], next.roles.slice(1), next.active, again ? null : target.accepted_at, again ? null : target.declined_at]);
      if (!next.active) await c.query('update sessions set revoked_at = $3 where user_id = $1 and firm_id = $2 and revoked_at is null', [userId, firmId, now()]);
      const who = one(await c.query('select email from users where id = $1', [userId]));
      const events = [];
      if (next.roles.join() !== before.roles.join()) events.push(['member_role_changed', `${before.roles.join('+')} to ${next.roles.join('+')}`]);
      if (next.active !== before.active) events.push([next.active ? 'member_reactivated' : 'member_deactivated', next.active ? (again ? 'invited again' : 'access restored') : 'sessions ended']);
      for (const [ev, what] of events) await c.query('insert into auth_events (user_id, email, event, outcome, detail) values ($1, $2, $3, $4, $5)', [userId, who ? who.email : '', ev, 'ok', `${what} in ${firmId}${by ? `, by ${by}` : ''}`]);
      return { userId, ...next, changed: true };
    }),
  };
}

module.exports = { createAuthStore, normaliseEmail };
