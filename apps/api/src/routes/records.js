/* Records and data protection routes (Phase 4). Each reads its input, calls the records service once
   with the sign-in context and turns the outcome into a reply. Still no DELETE anywhere: the only
   deletion is an approved purge, which is a decision on a request.
     POST /api/households/:id/exports          {kind: excel|json|print}   200 {logged: true} | 404
     GET  /api/households/:id/access           the access log, newest first                    | 404
     GET  /api/households/:id/subject-access   the subject access export, as a JSON download   | 404
     PUT  /api/households/:id/relationship     {endedOn: 'YYYY-MM-DD' | null}  200 {endedOn, retentionUntil} | 404 | 409
     POST /api/households/:id/purge-requests   {reason}   201 the request | 404 | 409
     GET  /api/records                         the records page: households, retention, purge requests
     POST /api/purge-requests/:id/approve      {note}     200 {purged, householdId, counts} | 403 | 404 | 409
     POST /api/purge-requests/:id/reject       {note}     200 {request} | 404 | 409
   Everything except the export log needs the admin or compliance role (403 forbidden).
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';

const notFound = send => res => send(res, 404, { error: 'Not found' });

function createRecordsRoutes({ records, ID_RE, send, readBody }) {
  const none = notFound(send);
  return async function recordsRoutes(req, res, p, ctx) {
    if (p === '/api/records' && req.method === 'GET') { send(res, 200, await records.overview(ctx)); return true; }

    let m = /^\/api\/purge-requests\/([^/]+)\/(approve|reject)$/.exec(p);
    if (m) {
      if (req.method !== 'POST') { send(res, 405, { error: 'Method not allowed' }); return true; }
      if (!ID_RE.test(m[1])) { none(res); return true; }
      const body = await readBody(req);
      const r = await records.decidePurge(ctx, m[1], { approve: m[2] === 'approve', note: body.note });
      r ? send(res, 200, r) : none(res);
      return true;
    }

    m = /^\/api\/households\/([^/]+)\/(exports|access|subject-access|relationship|purge-requests)$/.exec(p);
    if (!m) return false;
    const [, id, what] = m;
    const allowed = { exports: 'POST', access: 'GET', 'subject-access': 'GET', relationship: 'PUT', 'purge-requests': 'POST' }[what];
    if (req.method !== allowed) { send(res, 405, { error: 'Method not allowed' }); return true; }
    if (!ID_RE.test(id)) { none(res); return true; }
    let r;
    if (what === 'exports') r = await records.logExport(ctx, id, (await readBody(req)).kind);
    else if (what === 'access') r = await records.accessLog(ctx, id);
    else if (what === 'relationship') r = await records.setRelationship(ctx, id, await readBody(req));
    else if (what === 'purge-requests') r = await records.requestPurge(ctx, id, await readBody(req));
    else {
      r = await records.subjectAccess(ctx, id);
      if (r) {
        const name = `subject-access-${(r.household.reference || id).replace(/[^\w-]+/g, '_')}-${r.generatedAt.slice(0, 10)}.json`;
        send(res, 200, r, { 'Content-Disposition': `attachment; filename="${name}"` });
        return true;
      }
    }
    if (!r) none(res);
    else send(res, what === 'purge-requests' ? 201 : 200, r);
    return true;
  };
}

module.exports = { createRecordsRoutes };
