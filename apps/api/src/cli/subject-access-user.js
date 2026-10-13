/* node server.js subject-access-user EMAIL [OUT_FILE]: a subject access export for a sign-in account
   (an adviser, an administrator, a compliance user), run by the operator as the owner
   (DATABASE_OWNER_URL), who reads these tables in every firm. It holds what the app keeps about
   that person as a user: the account, memberships, sessions, recovery codes and one-time links
   (dates only), sign-in events, access requests made from that address, what they read
   (access log: actions and household ids, no client data) and the purge requests they made or
   decided. Never a secret: no password hash, authenticator secret, token or code hash (only whether
   each is set, and when). Client records are not in it: a client's request is answered by the
   firm, from the app (subject access export of the household).
   Written to OUT_FILE (created, never overwritten), else printed. The export is itself recorded as an
   auth event. Exit 0 done, 1 refused or failed. */
'use strict';
const fs = require('fs');
const { normaliseEmail } = require('../auth/store.js');

async function subjectAccessUser({ ownerUrl, args: [email, outFile], now = () => new Date(), log = console.log }) {
  if (!ownerUrl) { console.error('Set DATABASE_OWNER_URL: the owner reads the accounts of every firm.'); return 1; }
  email = normaliseEmail(email);
  if (!email) { console.error('Usage: node server.js subject-access-user EMAIL [OUT_FILE]'); return 1; }
  if (outFile && fs.existsSync(outFile)) { console.error(`${outFile} already exists; choose a new file name.`); return 1; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const u = (await c.query(`select id, email, name, active, created_at, password_set_at, password_hash is not null as has_password, totp_confirmed_at,
      totp_secret is not null as has_authenticator, failed_attempts, not_before, last_sign_in_at, reenrol from users where email = $1`, [email])).rows[0];
    if (!u) { console.error(`No account ${email}.`); return 1; }
    const rows = async (sql, p = [u.id]) => (await c.query(sql, p)).rows;
    const out = {
      kind: 'account-subject-access-export',
      format: 1,
      generatedAt: now().toISOString(),
      notice: [
        'What this service keeps about this person as a user of the app. Secrets (password, authenticator, links, recovery codes) are never included: only whether they are set and when.',
        'Household ids in the access log and purge requests identify client files; the client records themselves are not part of this export.',
        'Reply within one month of receiving the request (UK GDPR Article 12(3)).',
      ],
      account: u,
      memberships: await rows('select f.name as firm, m.firm_id, m.role, m.active, m.created_at from memberships m join firms f on f.id = m.firm_id where m.user_id = $1 order by m.created_at'),
      sessions: await rows('select firm_id, stage, created_at, last_seen_at, expires_at, revoked_at, ip, user_agent from sessions where user_id = $1 order by created_at'),
      recoveryCodes: await rows('select created_at, used_at from recovery_codes where user_id = $1 order by created_at'),
      oneTimeLinks: await rows('select purpose, created_at, expires_at, used_at from one_time_tokens where user_id = $1 order by created_at'),
      signInEvents: await rows('select at, event, outcome, ip, user_agent, detail from auth_events where user_id = $1 or (user_id is null and email = $2) order by id', [u.id, email]),
      accessRequests: await rows('select name, email, firm_name, note, status, created_at, decided_by, decided_at from access_requests where email = $1 order by created_at', [email]),
      accessLog: await rows('select firm_id, at, action, household_id, outcome, detail from access_log where user_id = $1 or (user_id is null and actor = $2) order by id', [u.id, email]),
      purgeRequests: await rows(`select firm_id, household_id, status, requested_at, decided_at, case when requested_by_id = $1 or requested_by = $2 then 'requested' else 'decided' end as part
        from purge_requests where requested_by_id = $1 or decided_by_id = $1 or requested_by = $2 or decided_by = $2 order by requested_at`, [u.id, email]),
    };
    const text = JSON.stringify(out, null, 2) + '\n';
    if (outFile) fs.writeFileSync(outFile, text, { flag: 'wx', mode: 0o600 }); else process.stdout.write(text);
    await c.query(`insert into auth_events (user_id, email, event, outcome, detail) values ($1, $2, 'subject_access', 'ok', 'operator command')`, [u.id, email]);
    if (outFile) log(`Subject access export for ${email} written to ${outFile}.`);
    return 0;
  } finally { await c.end(); }
}

module.exports = { subjectAccessUser };
