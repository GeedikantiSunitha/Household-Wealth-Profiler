/* Operator commands for accounts (Phase 2, step 2.8). They run through the sign-in store as the
   app role, inside the sign-in context that migration 0011 provides for exactly this, so routine
   decisions need no owner credential (create-user and set-password remain owner commands). A
   decision names the person who made it (--by "Name", required) and is written to the auth events.
     node server.js list-requests                              the access requests still pending from before
                                  registration replaced Request Access (nothing creates new ones)
     node server.js reset-mfa EMAIL --by "Name"               for someone who lost both the authenticator
                                  and the recovery codes: the authenticator no longer counts, every
                                  recovery code is revoked, every session ends, the user is told by
                                  email and must set up a new authenticator at the next sign-in.
                                  The password stays.
   Exit 0 done, 1 refused or failed. Nothing prints a secret or a link except through the mailer's
   development log fallback. */
'use strict';
const { normaliseEmail } = require('../repositories/auth-store.js');
const { ID_RE } = require('../repositories/ids.js');

const ROLES = ['admin', 'adviser', 'compliance'];

// Splits "--by NAME" out of the arguments
function byOf(args) {
  const i = args.indexOf('--by');
  if (i < 0 || !args[i + 1] || !args[i + 1].trim()) return { rest: args, by: '' };
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], by: args[i + 1].trim().slice(0, 200) };
}
const needBy = cmd => { console.error(`Name who is deciding: node server.js ${cmd} ... --by "Your Name"`); return 1; };

async function listRequests({ authStore }) {
  const rows = await authStore.pendingRequests();
  console.log(`${rows.length} pending request(s)`);
  for (const r of rows) console.log(`${r.id}  ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ${r.name}  <${r.email}>  ${r.firm_name || '(no firm given)'}  ${r.note ? JSON.stringify(r.note.slice(0, 120)) : ''}`);
  return 0;
}

async function resetMfa({ authStore, notify, args }) {
  const { rest, by } = byOf(args);
  if (!by) return needBy('reset-mfa EMAIL');
  const email = normaliseEmail(rest[0]);
  if (!email) { console.error('Usage: node server.js reset-mfa EMAIL --by "Name"'); return 1; }
  const user = await authStore.findUserByEmail(email);
  if (!user) { console.error(`No account ${email}`); return 1; }
  const codes = (await authStore.unusedRecoveryCodes(user.id)).length;
  await authStore.clearTotp(user.id);
  await authStore.replaceRecoveryCodes(user.id, []);
  const ended = await authStore.revokeAllSessions(user.id, {});
  await authStore.event({ userId: user.id, email, event: 'mfa_reset', outcome: 'ok', detail: `${codes} recovery code(s) revoked, ${ended} session(s) ended, by ${by}` });
  if (notify && notify.mfaReset) await notify.mfaReset(user);
  console.log(`Authenticator reset for ${email}: ${codes} recovery code(s) revoked, ${ended} session(s) ended. A new authenticator is set up at the next sign-in.`);
  return 0;
}

const COMMANDS = { 'list-requests': listRequests, 'reset-mfa': resetMfa };

module.exports = { COMMANDS, byOf };
