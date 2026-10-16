/* Sign-in for the API: who a request comes from.
     authenticate(req)  { user, firmId, stage, ... } signed in | { locked: true } too many failures | null
   Two ways in. The app's own sign-in (Phase 2): a cookie session from sessions.js, resolved through
   the sign-in store, giving the account's email as the user, the firm the session chose, the role
   there, the stage ('password' while the second step is pending) and the session's CSRF token.
   HTTP Basic (AUTH_USERS, development only: production refuses it): every user in the default firm,
   stage full, no session. Nothing else; there is no provider interface. */
'use strict';
const basic = require('./basic.js');

function createAuth(config, { authStore = null, sessions = null, now } = {}) {
  const b = config.users && config.users.size ? basic.createBasicAuth({ users: config.users, clientIpHeader: config.clientIpHeader, ...(now ? { now } : {}) }) : null;
  async function authenticate(req) {
    if (sessions && authStore) {
      const r = await sessions.resolve(req);
      if (r) return { user: r.user.email, email: r.user.email, name: r.user.name, userId: r.user.id, firmId: r.session.firm_id, firmName: r.firmName, role: r.role, roles: r.roles, stage: r.session.stage, session: r.session, csrf: r.csrf };
    }
    return b ? b.authenticate(req) : null;
  }
  return { authenticate };
}

module.exports = { createAuth, hashPassword: basic.hashPassword };
