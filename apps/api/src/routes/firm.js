/* Firm settings routes, for the signed-in user's firm. There is no DELETE: every version and
   audit entry is kept.
     GET /api/firm          the firm settings record (version 0 before the first save)
     PUT /api/firm          save {version, settings}   200 {version, changes} | 409
     GET /api/firm/audit    audit trail, newest first
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';

function createFirmRoutes({ firm, send, readBody }) {
  return async function firmRoutes(req, res, p, ctx) {
    if (p === '/api/firm' && req.method === 'GET') { send(res, 200, await firm.get(ctx)); return true; }
    if (p === '/api/firm/audit' && req.method === 'GET') { send(res, 200, await firm.audit(ctx)); return true; }
    if (p === '/api/firm' && req.method === 'PUT') {
      const r = await firm.save(ctx, await readBody(req));
      if (r.conflict) send(res, 409, { error: 'Firm settings were changed by someone else', code: 'version_conflict', ...r.conflict });
      else send(res, 200, r);
      return true;
    }
    return false;
  };
}

module.exports = { createFirmRoutes };
