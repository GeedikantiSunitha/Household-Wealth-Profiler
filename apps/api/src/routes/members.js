/* The team routes, for the signed-in administrator's firm (services/members.js decides who may).
   They are outside /api/auth/: nothing there creates or approves an account, and a test pins that.
     GET   /api/members           { members, seats, used }
     POST  /api/members           invite {email, name, role}   201 {ok: true}
     PATCH /api/members/:userId   change {role?, active?}      200 the member
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';

function createMembersRoutes({ members, send, readBody }) {
  return async function membersRoutes(req, res, p, ctx) {
    if (p === '/api/members' && req.method === 'GET') { send(res, 200, await members.list(ctx)); return true; }
    if (p === '/api/members' && req.method === 'POST') { send(res, 201, await members.invite(ctx, await readBody(req))); return true; }
    const m = /^\/api\/members\/([^/]+)$/.exec(p);
    if (m && req.method === 'PATCH') {
      let id = ''; try { id = decodeURIComponent(m[1]); } catch (e) { /* a broken % sequence names nobody: 404 below */ }
      send(res, 200, await members.update(ctx, id, await readBody(req)));
      return true;
    }
    return false;
  };
}

module.exports = { createMembersRoutes };
