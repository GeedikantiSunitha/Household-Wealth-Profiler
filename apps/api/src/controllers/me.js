/* GET /api/me: who is signed in, whether client data is encrypted at rest, and whether this is a
   production server (the interface then hides development conveniences such as sample data).
   With a cookie session: the account's email and name, the firm and role, the stage and the CSRF
   token the app must send with every write. The route is routes/me.js. */
'use strict';

function createMeController({ send, encrypted, production = false }) {
  return {
    me(req, res, ctx) {
      if (ctx.session) send(res, 200, { user: ctx.user, email: ctx.email, name: ctx.name, firmId: ctx.firmId, firmName: ctx.firmName, role: ctx.role, roles: ctx.roles, stage: ctx.stage, csrf: ctx.csrf, encrypted, production });
      else send(res, 200, { user: ctx.user, encrypted, production });
    },
  };
}

module.exports = { createMeController };
