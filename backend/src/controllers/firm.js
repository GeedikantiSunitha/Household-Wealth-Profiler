/* Firm settings controllers, for the signed-in user's firm. There is no delete: every version and
   audit entry is kept. Which method and path reaches which is routes/firm.js. */
'use strict';

function createFirmController({ firm, send, readBody }) {
  return {
    // GET /api/firm: the firm settings record (version 0 before the first save)
    async get(req, res, ctx) { send(res, 200, await firm.get(ctx)); },
    // GET /api/firm/audit: the audit trail, newest first
    async audit(req, res, ctx) { send(res, 200, await firm.audit(ctx)); },
    // PUT /api/firm: save {version, settings}: 200 {version, changes} | 409
    async save(req, res, ctx) {
      const r = await firm.save(ctx, await readBody(req));
      if (r.conflict) send(res, 409, { error: 'Firm settings were changed by someone else', code: 'version_conflict', ...r.conflict });
      else send(res, 200, r);
    },
  };
}

module.exports = { createFirmController };
