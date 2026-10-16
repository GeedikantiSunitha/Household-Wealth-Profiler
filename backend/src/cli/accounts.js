/* Operator commands for sign-in accounts, run as the owner (DATABASE_OWNER_URL): the app role
   cannot create accounts, by design.
     node server.js create-user EMAIL "NAME" [FIRM_ID] [ROLE]   an account with a membership in the
                                 firm (default firm, role adviser, unless given; ROLE may be several,
                                 comma-separated, e.g. admin,compliance); an existing account gains
                                 the membership only, with access at once. Prints the account id.
     node server.js set-password EMAIL                          reads the password from standard input
                                 (echo or a file, never the command line, which shells keep in history),
                                 checks the policy, stores the hash. The account can then sign in and
                                 is asked to set up its authenticator at its first sign-in.
   Neither prints or logs a password. Exit 0 done, 1 refused or failed. */
'use strict';
const { hashPassword, checkPolicy } = require('../services/auth/password.js');
const { normaliseEmail } = require('../repositories/auth-store.js');
const { DEFAULT_FIRM_ID, ID_RE } = require('../repositories/ids.js');

const ROLES = ['admin', 'adviser', 'compliance'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function withOwner(ownerUrl, fn) {
  const pg = require('pg');
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function createUser({ ownerUrl, args: [email, name, firmId = DEFAULT_FIRM_ID, role = 'adviser'] }) {
  const roles = String(role).split(',').map(r => r.trim()); // ROLE may be several, comma-separated: admin,compliance
  if (!ownerUrl) { console.error('Set DATABASE_OWNER_URL to the database to add the account to.'); return 1; }
  email = normaliseEmail(email);
  if (!EMAIL.test(email) || !name) { console.error('Usage: node server.js create-user EMAIL "NAME" [FIRM_ID] [ROLE]'); return 1; }
  if (!ID_RE.test(firmId) || !roles.every(r => ROLES.includes(r)) || new Set(roles).size !== roles.length) { console.error(`FIRM_ID must be a uuid and ROLE one of ${ROLES.join(', ')} (or several, comma-separated)`); return 1; }
  return withOwner(ownerUrl, async c => {
    await c.query('begin');
    const firm = (await c.query('select id from firms where id = $1', [firmId])).rows[0];
    if (!firm) { await c.query('rollback'); console.error(`No firm ${firmId}`); return 1; }
    let u = (await c.query('select id from users where email = $1', [email])).rows[0];
    const fresh = !u;
    if (fresh) u = (await c.query('insert into users (email, name) values ($1, $2) returning id', [email, name])).rows[0];
    // The operator's own decision: access at once, even where an invitation was pending or declined
    await c.query(`insert into memberships (user_id, firm_id, role, extra_roles) values ($1, $2, $3, $4)
      on conflict (user_id, firm_id) do update set role = excluded.role, extra_roles = excluded.extra_roles, active = true, accepted_at = coalesce(memberships.accepted_at, now()), declined_at = null`, [u.id, firmId, roles[0], roles.slice(1)]);
    await c.query('commit');
    console.log(`${fresh ? 'Account created' : 'Membership added to the existing account'}: ${u.id} (${roles.join('+')} in firm ${firmId}). Now: node server.js set-password ${email}`);
    return 0;
  });
}

const readStdin = () => new Promise(ok => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { s += d; }); process.stdin.on('end', () => ok(s)); });

async function setPassword({ ownerUrl, args: [email], input = readStdin }) {
  if (!ownerUrl) { console.error('Set DATABASE_OWNER_URL to the database holding the account.'); return 1; }
  email = normaliseEmail(email);
  if (!EMAIL.test(email)) { console.error('Usage: node server.js set-password EMAIL   (the password on standard input)'); return 1; }
  const password = (await input()).replace(/\r?\n$/, '');
  const problem = checkPolicy(password);
  if (problem) { console.error(problem); return 1; }
  const hash = await hashPassword(password);
  return withOwner(ownerUrl, async c => {
    const r = await c.query('update users set password_hash = $2, password_set_at = now(), failed_attempts = 0, not_before = null where email = $1 returning id', [email, hash]);
    if (!r.rowCount) { console.error(`No account ${email}. Create it first: node server.js create-user ${email} "NAME"`); return 1; }
    await c.query(`insert into auth_events (user_id, email, event, outcome, detail) values ($1, $2, 'password_set', 'ok', 'operator command')`, [r.rows[0].id, email]);
    console.log(`Password set for ${email}.`);
    return 0;
  });
}

module.exports = { createUser, setPassword };
