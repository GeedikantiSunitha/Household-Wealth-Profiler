/* Inviting someone to an account: the account (and its membership) is made or found, an
   invitation token is issued (24 hours, single use, older ones invalidated) and the link is sent.
   Used by operator tooling and by the approval of an access request; the link itself is redeemed
   through POST /api/auth/invite, which sets the password. Creating an account here runs as the
   app role within sign-in (migration 0011 allows it), so the server needs no owner connection. */
'use strict';
const { normaliseEmail } = require('../../repositories/auth-store.js');
const { ID_RE } = require('../../repositories/ids.js');

const INVITE_TTL_MS = 24 * 3600e3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['admin', 'adviser', 'compliance'];

function createInvites({ authStore, notify, now = Date.now }) {
  async function create({ email, name, firmId, role = 'adviser', invitedBy = '' }) {
    email = normaliseEmail(email);
    if (!EMAIL.test(email) || email.length > 254) throw Object.assign(new Error('A valid email address is required'), { status: 400, code: 'bad_request' });
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw Object.assign(new Error('A name is required'), { status: 400, code: 'bad_request' });
    if (!ID_RE.test(firmId) || !ROLES.includes(role)) throw Object.assign(new Error('A firm and a role are required'), { status: 400, code: 'bad_request' });
    const { userId, created, firmName } = await authStore.ensureUser({ email, name: name.trim(), firmId, role });
    const { token } = await authStore.issueToken(userId, 'invite', INVITE_TTL_MS);
    await notify.inviteLink({ email, name: name.trim() }, token, { firmName });
    await authStore.event({ userId, email, event: 'invite_sent', outcome: 'ok', detail: `${created ? 'new account' : 'existing account'}, ${role} in ${firmId}${invitedBy ? `, by ${invitedBy}` : ''}` });
    return { userId, created };
  }
  return { create };
}

module.exports = { createInvites, INVITE_TTL_MS };
