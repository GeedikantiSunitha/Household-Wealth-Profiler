/* The team of the signed-in user's firm (Phase 3): who has an account there, in which role, and
   whether they can still sign in. Every call is for administrators (services/access.js) and for the
   firm in ctx; the rules that must hold whoever calls (the last administrator, the seats, ending
   sessions on deactivation, the firm-only update policy) are in auth/store.js and the database.
     list(ctx)                      { members: [{ userId, email, name, role, roles, active, invitation, createdAt,
                                      hasPassword, mfa, lastSignInAt }], seats, used }. role is the primary role,
                                      roles every role they hold; invitation is 'pending' or 'declined' for an
                                      existing account that has not (or not yet) accepted, else null.
     invite(ctx, { email, name, roles })   (role: 'adviser' also accepted, for one role)
                                    { ok: true }. A new email gets an account and an invitation link (24 hours,
                                    single use) and is on the team at once. An email that already has an account
                                    (in another firm) is added as a PENDING membership and told by email: it gives
                                    no access until the person accepts at their next sign-in (no link: redeeming one
                                    sets a password). The reply is the same either way, so it says nothing about
                                    other firms. 400 bad_request, 409 already_member (this firm only), 402 seats_full.
     update(ctx, userId, { roles? | role?, active? })
                                    the member after the change. One or more roles; at least one. Not your own roles
                                    or access (400 self_change): another administrator does that. 404 not_found,
                                    409 last_admin, 402 seats_full on reactivation. Deactivating ends their sessions
                                    in this firm at once.
   Changes are auth events (member_role_changed, member_deactivated, member_reactivated, invite_sent) naming
   the administrator who made them. */
'use strict';
const { authorize, ROLES } = require('./access.js');
const { normaliseEmail } = require('../repositories/auth-store.js');
const { INVITE_TTL_MS } = require('./auth/invites.js');
const { ID_RE } = require('../repositories/ids.js');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bad = (message, code = 'bad_request') => Object.assign(new Error(message), { status: 400, code });
// roles: an array of one to three different roles; role: a single one (the older form). undefined when neither is given.
function rolesFrom(body, fallback) {
  const given = body && body.roles !== undefined ? body.roles : body && body.role !== undefined ? [body.role] : fallback;
  if (given === undefined) return undefined;
  if (!Array.isArray(given) || !given.length || given.length > ROLES.length || new Set(given).size !== given.length || !given.every(r => ROLES.includes(r))) throw bad(`Give one or more different roles from ${ROLES.join(', ')}`);
  return given;
}

function createMemberService({ authStore, notify }) {
  const actor = ctx => ctx.email || ctx.user;

  return {
    async list(ctx) {
      authorize(ctx, 'members.manage');
      const [members, seats] = await Promise.all([authStore.members(ctx.firmId), authStore.seats(ctx.firmId)]);
      return { members, seats: seats ? seats.seats : 0, used: seats ? seats.used : 0 };
    },

    async invite(ctx, body) {
      authorize(ctx, 'members.manage');
      const { name } = body || {};
      const email = normaliseEmail(body && body.email);
      if (!EMAIL.test(email) || email.length > 254) throw bad('A valid email address is required');
      if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001F\u007F]/.test(name)) throw bad('A name is required (at most 200 characters)');
      const roles = rolesFrom(body, ['adviser']);
      const { userId, created, firmName, hasPassword, pending } = await authStore.addMember({ email, name: name.trim(), firmId: ctx.firmId, roles });
      if (hasPassword) await notify.invitedToFirm({ email, name: name.trim() }, { firmName, roles });
      else { const { token } = await authStore.issueToken(userId, 'invite', INVITE_TTL_MS); await notify.inviteLink({ email, name: name.trim() }, token, { firmName }); }
      await authStore.event({ userId, email, event: 'invite_sent', outcome: 'ok', detail: `${created ? 'new account' : 'existing account, pending acceptance'}, ${roles.join('+')} in ${ctx.firmId}, by ${actor(ctx)}` });
      return { ok: true };
    },

    async update(ctx, userId, body) {
      authorize(ctx, 'members.manage');
      if (typeof userId !== 'string' || !ID_RE.test(userId)) throw Object.assign(new Error('No such person on this team'), { status: 404, code: 'not_found' });
      const roles = rolesFrom(body);
      const { active } = body || {};
      if (roles === undefined && active === undefined) throw bad('Give the roles or an active flag to change');
      if (active !== undefined && typeof active !== 'boolean') throw bad('active must be true or false');
      if (userId === ctx.userId) throw bad('You cannot change your own roles or access. Ask another administrator.', 'self_change');
      await authStore.changeMember(ctx.firmId, userId, { roles, active }, { by: actor(ctx) });
      return (await authStore.members(ctx.firmId)).find(m => m.userId === userId);
    },
  };
}

module.exports = { createMemberService };
