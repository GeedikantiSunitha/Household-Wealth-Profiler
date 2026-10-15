/* Records and data protection routes (Phase 4): which method and path reaches which controller
   (controllers/records.js). Still no DELETE anywhere: the only deletion is an approved purge,
   which is a decision on a request.
     POST /api/households/:id/exports          {kind: excel|json|print}   200 {logged: true} | 404
     GET  /api/households/:id/access           the access log, newest first                    | 404
     GET  /api/households/:id/subject-access   the subject access export, as a JSON download   | 404
     PUT  /api/households/:id/relationship     {endedOn: 'YYYY-MM-DD' | null}  200 {endedOn, retentionUntil} | 404 | 409
     POST /api/households/:id/purge-requests   {reason}   201 the request | 404 | 409
     GET  /api/records                         the records page: households, retention, purge requests
     POST /api/purge-requests/:id/approve      {note}     200 {purged, householdId, counts} | 403 | 404 | 409
     POST /api/purge-requests/:id/reject       {note}     200 {request} | 404 | 409
   Another method on one of these paths is 405; an :id that is not a uuid is 404. Everything
   except the export log needs the admin or compliance role (403 forbidden, by the service, which
   logs the refusal). Returns a promise of true when it handled the request, false otherwise. */
'use strict';
const { createRouteTable } = require('./table.js');
const { createRecordsController } = require('../controllers/records.js');

function createRecordsRoutes({ records, ID_RE, send, readBody }) {
  const c = createRecordsController({ records, send, readBody });
  const household = (what, methods) => ({ path: new RegExp(`^/api/households/([^/]+)/${what}$`), params: ['id'], ids: ['id'], strict: true, methods });
  return createRouteTable([
    { path: '/api/records', methods: { GET: c.overview } },
    { path: /^\/api\/purge-requests\/([^/]+)\/(approve|reject)$/, params: ['id', 'decision'], ids: ['id'], strict: true, methods: { POST: c.decidePurge } },
    household('exports', { POST: c.logExport }),
    household('access', { GET: c.accessLog }),
    household('subject-access', { GET: c.subjectAccess }),
    household('relationship', { PUT: c.setRelationship }),
    household('purge-requests', { POST: c.requestPurge }),
  ], { send, ID_RE });
}

module.exports = { createRecordsRoutes };
