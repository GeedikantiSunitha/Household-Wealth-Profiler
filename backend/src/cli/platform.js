/* The platform operator's commands (Phase 3, 3.4). They run as the operator role, hwp_operator
   (DATABASE_OPERATOR_URL), which can manage firms and accounts and cannot read client records or any
   account secret: db/operator.sql grants exactly that, and the database enforces it. The operator's
   machine needs no DATA_KEY. Every change is an event in auth_events, naming the command.
     node server.js firm-create "NAME" [SEATS]      a new firm (default 5 seats); prints its id
     node server.js firm-list                       every firm with its status and seats in use
     node server.js firm-seats FIRM_ID SEATS        the seats a firm may use (not below those in use)
     node server.js firm-status FIRM_ID active|suspended
                                                    suspending ends every session in the firm at once;
                                                    nothing is deleted, and activating restores access
     node server.js access-review [FIRM_ID]         who has access, in which role, with an authenticator,
                                                    last sign-in and open sessions: for the periodic access review
     node server.js grant-operator                  as the OWNER (DATABASE_OWNER_URL): applies db/operator.sql
   Accounts are made with create-user and set-password (cli/accounts.js), which use the same connection.
   Exit 0 done, 1 refused or failed. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ID_RE } = require('../repositories/ids.js');

const OPERATOR_SQL = path.join(__dirname, '..', '..', '..', 'db', 'operator.sql');
const STALE_DAYS = 90;

async function withDb(url, fn) {
  const pg = require('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const needUrl = url => { if (!url) { console.error('Set DATABASE_OPERATOR_URL to the database to administer.'); return false; } return true; };
const event = (c, ev, detail) => c.query(`insert into auth_events (user_id, email, event, outcome, detail) values (null, '', $1, 'ok', $2)`, [ev, detail]);
const seatsOk = n => Number.isInteger(n) && n >= 1 && n <= 100000;

async function grantOperator({ ownerUrl, sql = null }) {
  if (!ownerUrl) { console.error('Set DATABASE_OWNER_URL: the operator role is granted by the owner.'); return 1; }
  return withDb(ownerUrl, async c => {
    try { await c.query(sql || fs.readFileSync(OPERATOR_SQL, 'utf8')); } catch (e) { console.error(e.message); return 1; }
    console.log('The operator role (hwp_operator) now has exactly the access in db/operator.sql: firms, accounts, memberships, sessions and the event log, and no client records.');
    return 0;
  });
}

async function createFirm({ url, args: [name, seats = '5'] }) {
  if (!needUrl(url)) return 1;
  const n = Number(seats);
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || !seatsOk(n)) { console.error('Usage: node server.js firm-create "NAME" [SEATS]   (a name of at most 200 characters; seats a whole number)'); return 1; }
  const id = crypto.randomUUID();
  return withDb(url, async c => {
    await c.query('begin');
    await c.query('insert into firms (id, name, seats) values ($1, $2, $3)', [id, name.trim(), n]);
    await event(c, 'firm_created', `${id}: ${name.trim()}, ${n} seats, by operator command`);
    await c.query('commit');
    console.log(`Firm created: ${id} (${name.trim()}, ${n} seats). Now its first administrator: node server.js create-user EMAIL "NAME" ${id} admin`);
    return 0;
  });
}

async function listFirms({ url }) {
  if (!needUrl(url)) return 1;
  return withDb(url, async c => {
    const rows = (await c.query(`select f.id, f.name, f.status, f.seats, (select count(*)::int from memberships m where m.firm_id = f.id and m.active) as used from firms f order by f.name`)).rows;
    if (!rows.length) console.log('No firms.');
    for (const f of rows) console.log(`${f.id}  ${f.status.padEnd(9)} ${String(f.used).padStart(3)}/${f.seats} seats  ${f.name}`);
    return 0;
  });
}

async function setSeats({ url, args: [firmId, seats] }) {
  if (!needUrl(url)) return 1;
  const n = Number(seats);
  if (!ID_RE.test(String(firmId)) || !seatsOk(n)) { console.error('Usage: node server.js firm-seats FIRM_ID SEATS'); return 1; }
  return withDb(url, async c => {
    await c.query('begin');
    const f = (await c.query('select name, seats from firms where id = $1 for update', [firmId])).rows[0];
    if (!f) { await c.query('rollback'); console.error(`No firm ${firmId}`); return 1; }
    const used = (await c.query('select count(*)::int n from memberships where firm_id = $1 and active', [firmId])).rows[0].n;
    if (n < used) { await c.query('rollback'); console.error(`${used} people are active in ${f.name}; deactivate some before lowering the seats to ${n}.`); return 1; }
    await c.query('update firms set seats = $2 where id = $1', [firmId, n]);
    await event(c, 'firm_seats', `${firmId}: ${f.seats} to ${n}, by operator command`);
    await c.query('commit');
    console.log(`${f.name}: ${n} seats (${used} in use).`);
    return 0;
  });
}

async function setStatus({ url, args: [firmId, status] }) {
  if (!needUrl(url)) return 1;
  if (!ID_RE.test(String(firmId)) || !['active', 'suspended'].includes(status)) { console.error('Usage: node server.js firm-status FIRM_ID active|suspended'); return 1; }
  return withDb(url, async c => {
    await c.query('begin');
    const f = (await c.query('select name, status from firms where id = $1 for update', [firmId])).rows[0];
    if (!f) { await c.query('rollback'); console.error(`No firm ${firmId}`); return 1; }
    await c.query('update firms set status = $2 where id = $1', [firmId, status]);
    let ended = 0;
    if (status === 'suspended') ended = (await c.query('update sessions set revoked_at = now() where firm_id = $1 and revoked_at is null', [firmId])).rowCount;
    await event(c, 'firm_status', `${firmId}: ${f.status} to ${status}${status === 'suspended' ? `, ${ended} session(s) ended` : ''}, by operator command`);
    await c.query('commit');
    console.log(status === 'suspended' ? `${f.name} is suspended; ${ended} session(s) ended. Nothing was deleted.` : `${f.name} is active again.`);
    return 0;
  });
}

async function accessReview({ url, args: [firmId], now = () => new Date() }) {
  if (!needUrl(url)) return 1;
  if (firmId !== undefined && !ID_RE.test(String(firmId))) { console.error('Usage: node server.js access-review [FIRM_ID]'); return 1; }
  return withDb(url, async c => {
    const rows = (await c.query(
      `select f.id as firm_id, f.name as firm, f.status as firm_status, u.email, u.name, m.role, m.extra_roles, m.accepted_at, m.declined_at, m.active, u.active as account_active,
              (u.password_set_at is not null) as has_password, (u.totp_confirmed_at is not null and not u.reenrol) as mfa, u.last_sign_in_at,
              (select count(*)::int from sessions s where s.user_id = u.id and s.firm_id = f.id and s.revoked_at is null and s.expires_at > now()) as sessions
         from memberships m join users u on u.id = m.user_id join firms f on f.id = m.firm_id
        where ($1::uuid is null or f.id = $1) order by f.name, m.active desc, m.role, u.email`, [firmId || null])).rows;
    const cutoff = now().getTime() - STALE_DAYS * 86400e3;
    let flagged = 0, firm = null;
    for (const r of rows) {
      if (r.firm_id !== firm) { firm = r.firm_id; console.log(`\n${r.firm} (${r.firm_id})${r.firm_status === 'active' ? '' : '  [' + r.firm_status + ']'}`); }
      const flags = [];
      if (r.active && !r.account_active) flags.push('account switched off');
      if (r.active && !r.accepted_at && !r.declined_at) flags.push('invitation not yet accepted');
      if (r.declined_at) flags.push('invitation declined');
      if (r.active && !r.has_password) flags.push('invited, not yet signed up');
      if (r.active && r.has_password && !r.mfa) flags.push('no authenticator');
      if (r.active && r.has_password && !r.last_sign_in_at) flags.push('never signed in');
      else if (r.active && r.last_sign_in_at && new Date(r.last_sign_in_at).getTime() < cutoff) flags.push(`no sign-in for ${STALE_DAYS}+ days`);
      if (flags.length) flagged++;
      console.log(`  ${r.active ? 'active  ' : 'inactive'} ${[r.role, ...r.extra_roles].join('+').padEnd(10)} ${r.email}${r.name ? ' (' + r.name + ')' : ''}  last sign-in ${r.last_sign_in_at ? new Date(r.last_sign_in_at).toISOString().slice(0, 10) : 'never'}, ${r.sessions} open session(s)${flags.length ? '   <- ' + flags.join(', ') : ''}`);
    }
    console.log(`\n${rows.length} membership(s) reviewed, ${flagged} to look at. Check each against who should still have access.`);
    return 0;
  });
}

module.exports = { grantOperator, createFirm, listFirms, setSeats, setStatus, accessReview };
