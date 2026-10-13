/* Household routes. Each reads its input, calls the household service once with the sign-in
   context { user, firmId } and turns the outcome into a reply. There is deliberately no DELETE:
   records are kept for regulatory retention.
     GET  /api/households              client list
     POST /api/households              create            201 {id, version}; 409 when the firm already
                                       has a household with that client reference
                                       with an Idempotency-Key header, a repeat within a day gets
                                       the first reply (no second household); a bad key is 400
     GET  /api/households/:id          the record        404 if unknown
     PUT  /api/households/:id          save {version, state}   200 {version, changes} | 404 | 409
     GET  /api/households/:id/audit    audit trail, newest first   404 if unknown
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';

const IDEM_KEY = /^[A-Za-z0-9_-]{8,200}$/;

function createHouseholdRoutes({ households, ID_RE, send, readBody }) {
  return async function householdRoutes(req, res, p, ctx) {
    if (p === '/api/households' && req.method === 'GET') { send(res, 200, await households.list(ctx)); return true; }
    if (p === '/api/households' && req.method === 'POST') {
      const key = req.headers['idempotency-key'];
      if (key !== undefined && !IDEM_KEY.test(key)) { send(res, 400, { error: 'Idempotency-Key must be 8 to 200 letters, digits, "-" or "_"', code: 'bad_idempotency_key' }); return true; }
      const body = await readBody(req);
      send(res, 201, await households.create(ctx, body.state, key ? { idempotencyKey: key } : undefined));
      return true;
    }
    const m = /^\/api\/households\/([^/]+)(\/audit)?$/.exec(p);
    if (!m) return false;
    const id = m[1];
    if (!ID_RE.test(id)) { send(res, 404, { error: 'Not found' }); return true; }
    if (m[2] && req.method === 'GET') {
      const entries = await households.audit(ctx, id);
      entries ? send(res, 200, entries) : send(res, 404, { error: 'Not found' });
      return true;
    }
    if (!m[2] && req.method === 'GET') {
      const rec = await households.get(ctx, id);
      rec ? send(res, 200, rec) : send(res, 404, { error: 'Not found' });
      return true;
    }
    if (!m[2] && req.method === 'PUT') {
      const r = await households.save(ctx, id, await readBody(req));
      if (r.notFound) send(res, 404, { error: 'Not found' });
      else if (r.conflict) send(res, 409, { error: 'This household was changed by someone else', code: 'version_conflict', ...r.conflict });
      else send(res, 200, r);
      return true;
    }
    return false;
  };
}

module.exports = { createHouseholdRoutes };
