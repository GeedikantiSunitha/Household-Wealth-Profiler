/* The team routes, for the signed-in administrator's firm (services/members.js decides who may):
   which method and path reaches which controller (controllers/members.js). They are outside
   /api/auth/: nothing there creates or approves an account, and a test pins that.
     GET   /api/members           { members, seats, used }
     POST  /api/members           invite {email, name, role}   201 {ok: true}
     PATCH /api/members/:userId   change {role?, active?}      200 the member
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';
const { createRouteTable } = require('./table.js');
const { createMembersController } = require('../controllers/members.js');

function createMembersRoutes({ members, send, readBody }) {
  const c = createMembersController({ members, send, readBody });
  return createRouteTable([
    { path: '/api/members', methods: { GET: c.list, POST: c.invite } },
    { path: /^\/api\/members\/([^/]+)$/, params: ['userId'], methods: { PATCH: c.update } },
  ], { send });
}

module.exports = { createMembersRoutes };
