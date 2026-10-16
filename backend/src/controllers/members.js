/* The team controllers, for the signed-in administrator's firm (services/members.js decides who
   may). They are outside /api/auth/: nothing there creates or approves an account, and a test pins
   that. Which method and path reaches which is routes/members.js. */
'use strict';

function createMembersController({ members, send, readBody }) {
  return {
    // GET /api/members: { members, seats, used }
    async list(req, res, ctx) { send(res, 200, await members.list(ctx)); },
    // POST /api/members: invite {email, name, role}: 201 {ok: true}
    async invite(req, res, ctx) { send(res, 201, await members.invite(ctx, await readBody(req))); },
    // PATCH /api/members/:userId: change {role?, active?}: 200 the member
    async update(req, res, ctx, { userId }) {
      let id = ''; try { id = decodeURIComponent(userId); } catch (e) { /* a broken % sequence names nobody: the service answers 404 */ }
      send(res, 200, await members.update(ctx, id, await readBody(req)));
    },
  };
}

module.exports = { createMembersController };
