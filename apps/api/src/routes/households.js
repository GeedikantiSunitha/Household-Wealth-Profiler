/* Household routes. Each reads its input, calls the household service once and turns the outcome
   into a reply. There is deliberately no DELETE: records are kept for regulatory retention.
     GET  /api/households              client list
     POST /api/households              create            201 {id, version}
     GET  /api/households/:id          the record        404 if unknown
     PUT  /api/households/:id          save {version, state}   200 {version, changes} | 404 | 409
     GET  /api/households/:id/audit    audit trail, newest first   404 if unknown
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';

function createHouseholdRoutes({ households, ID_RE, send, readBody }) {
  return async function householdRoutes(req, res, p, user) {
    if (p === '/api/households' && req.method === 'GET') { send(res, 200, await households.list()); return true; }
    if (p === '/api/households' && req.method === 'POST') {
      const body = await readBody(req);
      send(res, 201, await households.create(body.state, user));
      return true;
    }
    const m = /^\/api\/households\/([^/]+)(\/audit)?$/.exec(p);
    if (!m) return false;
    const id = m[1];
    if (!ID_RE.test(id)) { send(res, 404, { error: 'Not found' }); return true; }
    if (m[2] && req.method === 'GET') {
      const entries = await households.audit(id);
      entries ? send(res, 200, entries) : send(res, 404, { error: 'Not found' });
      return true;
    }
    if (!m[2] && req.method === 'GET') {
      const rec = await households.get(id);
      rec ? send(res, 200, rec) : send(res, 404, { error: 'Not found' });
      return true;
    }
    if (!m[2] && req.method === 'PUT') {
      const r = await households.save(id, await readBody(req), user);
      if (r.notFound) send(res, 404, { error: 'Not found' });
      else if (r.conflict) send(res, 409, { error: 'This household was changed by someone else', ...r.conflict });
      else send(res, 200, r);
      return true;
    }
    return false;
  };
}

module.exports = { createHouseholdRoutes };
