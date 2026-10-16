/* Who may do what (Phase 3). One table, checked in the services before anything is read or written,
   so no route and no screen can forget it. A person has one or more roles in a firm (memberships.role
   and extra_roles): their permissions are everything any of their roles allows.
     admin       works on client files, changes the firm settings and manages the team
     adviser     works on client files
     compliance  reads every client file and the audit trails, and records the review sign-off
                 (the reviewer, review date, outcome and notes of the four-eyes check), nothing else
   The roles come from the session's membership in the firm it is working in, looked up on every
   request (auth/sessions.js), so a change of role or a deactivation applies at once.
   HTTP Basic (AUTH_USERS) is for development only and production refuses it: it has no session and
   no role and is unrestricted, as it always was, so local trials and the contract tests behave as before.
   Anything not in the table, and any role not named in it, is refused.

   Separation of duties, per file and by account (not by name): whoever has changed a client file
   cannot be the one who signs it off, however many roles they hold. The service keeps, on each
   record, the accounts that have changed it (contributors); the reviewer is the signed-in account, put
   on the sign-off by the server (stampSignOff), never typed. A file saved before contributors were
   kept has none recorded; for those only the saves from now on count, and the named preparer is still
   compared by name.

   Refusals are 403 with the code "forbidden"; the sign-off rules add "sign_off_identity" and
   "separation_of_duties" (403) and "four_eyes" (400, a rule about the record rather than the person). */
'use strict';

const ROLES = Object.freeze(['admin', 'adviser', 'compliance']);
const DEVELOPMENT = 'development';

const ALL = Object.freeze([...ROLES]);
const ACTIONS = Object.freeze({
  'households.read': ALL,
  'households.audit': ALL,
  'households.write': Object.freeze(['admin', 'adviser']),
  'firm.read': ALL,
  'firm.audit': Object.freeze(['admin', 'compliance']),
  'firm.write': Object.freeze(['admin']),
  'members.manage': Object.freeze(['admin']),
  // Records and retention (Phase 4): ending a relationship, purge requests and decisions, the access log, subject access exports
  'records.manage': Object.freeze(['admin', 'compliance']),
});

// What only a compliance reviewer records, as the field paths the rules engine reports (HWP.diff)
const SIGN_OFF_FIELDS = Object.freeze(['compliance.reviewer', 'compliance.reviewDate', 'compliance.outcome', 'compliance.reviewNotes']);
const SIGN_OFF = new Set(SIGN_OFF_FIELDS);

const WHAT = {
  'households.read': 'read client files', 'households.audit': 'read client audit trails', 'households.write': 'change client files',
  'firm.read': 'read the firm settings', 'firm.audit': 'read the firm audit trail', 'firm.write': 'change the firm settings',
  'members.manage': 'manage the team', 'records.manage': 'manage records and retention',
};
const WHO = { 'households.write': 'an adviser or an administrator', 'firm.audit': 'an administrator or a compliance reviewer', 'firm.write': 'an administrator', 'members.manage': 'an administrator', 'records.manage': 'an administrator or a compliance reviewer' };

const refuse = (status, code, error) => Object.assign(new Error(error), { status, code });
const norm = v => String(v == null ? '' : v).trim().toLowerCase();

// A request acts as its roles in the firm; HTTP Basic (no session) as 'development'; a session with none, or an unknown one, as nothing
const isDevelopment = ctx => !ctx.session;
function rolesOf(ctx) {
  if (isDevelopment(ctx)) return [DEVELOPMENT];
  const given = Array.isArray(ctx.roles) && ctx.roles.length ? ctx.roles : [ctx.role];
  return [...new Set(given)].filter(r => ROLES.includes(r));
}
const hasRole = (ctx, role) => isDevelopment(ctx) || rolesOf(ctx).includes(role);

function can(ctx, action) {
  const allowed = ACTIONS[action];
  if (!allowed) return false;
  return isDevelopment(ctx) || rolesOf(ctx).some(r => allowed.includes(r));
}

function authorize(ctx, action) {
  if (can(ctx, action)) return;
  throw refuse(403, 'forbidden', `Only ${WHO[action] || 'someone with a different role'} can ${WHAT[action] || 'do this'}.`);
}

const signOffBlank = c => !norm(c.reviewer) && !norm(c.reviewDate) && (!norm(c.outcome) || norm(c.outcome) === 'pending');
const touchesSignOff = changes => changes.some(c => SIGN_OFF.has(c.field));

// The server puts the signed-in reviewer and today's date on a sign-off; they are never typed.
// Setting the outcome back to pending withdraws it, and the reviewer and date go with it.
function stampSignOff(ctx, s, today) {
  if (isDevelopment(ctx) || !hasRole(ctx, 'compliance')) return;
  const c = s.compliance;
  if (!norm(c.outcome) || norm(c.outcome) === 'pending') { c.reviewer = ''; c.reviewDate = ''; return; }
  if (!norm(ctx.name)) throw refuse(403, 'sign_off_identity', 'Your account has no name, so a sign-off cannot be recorded in your name. Ask an administrator to add it.');
  c.reviewer = ctx.name; c.reviewDate = today;
}

// A save: `changes` is HWP.diff(stored, submitted), `next` the submitted state, `rec` the stored record
// (its contributors are the accounts that have changed the file).
function guardSave(ctx, changes, next, rec = {}) {
  if (isDevelopment(ctx)) return;
  authorize(ctx, 'households.read');
  if (!changes.length) return;
  const others = changes.filter(c => !SIGN_OFF.has(c.field));
  const signing = touchesSignOff(changes);
  if (others.length && !can(ctx, 'households.write')) throw refuse(403, 'forbidden', 'A compliance reviewer can record the review sign-off only. The rest of the file is changed by an adviser or an administrator.');
  if (!signing) return;
  if (!hasRole(ctx, 'compliance')) throw refuse(403, 'forbidden', 'Only a compliance reviewer can record the review sign-off.');
  const c = next.compliance || {};
  if (signOffBlank(c)) return; // withdrawing a sign-off is always allowed to a reviewer, and is an audited change
  if (!norm(ctx.name) || norm(c.reviewer) !== norm(ctx.name)) throw refuse(403, 'sign_off_identity', 'The reviewer on a sign-off is the account that records it. It cannot be someone else.');
  // Separation of duties: not in the same save as changes to the file, and not by anyone who has changed the file before
  if (others.length) throw refuse(403, 'separation_of_duties', 'Whoever changes a file cannot sign it off. Save your changes first; someone else records the sign-off.');
  if (ctx.userId && Array.isArray(rec.contributors) && rec.contributors.includes(ctx.userId)) throw refuse(403, 'separation_of_duties', 'You have worked on this file, so someone else must sign it off.');
  if (norm(c.reviewer) && norm(c.reviewer) === norm(c.preparer)) throw refuse(400, 'four_eyes', 'The reviewer must be a different person from the preparer (four-eyes check).');
}

// A new household: a role that may write, carrying no sign-off (that is for a reviewer, on a file that exists)
function guardCreate(ctx, next, HWP = require('../../../packages/core/core.js')) {
  authorize(ctx, 'households.write');
  if (isDevelopment(ctx)) return;
  if (HWP.diff(null, next).some(c => SIGN_OFF.has(c.field))) throw refuse(403, 'forbidden', 'Only a compliance reviewer can record the review sign-off, and only on a file that exists.');
}

// The accounts that have changed a file, after a save by ctx that changed something other than the sign-off
const withContributor = (rec, ctx) => (ctx.userId && !isDevelopment(ctx) ? [...new Set([...(rec.contributors || []), ctx.userId])] : rec.contributors);

module.exports = { ROLES, ACTIONS, SIGN_OFF_FIELDS, rolesOf, hasRole, can, authorize, touchesSignOff, signOffBlank, stampSignOff, guardSave, guardCreate, withContributor };
