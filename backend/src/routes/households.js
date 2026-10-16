/* Household routes: which method and path reaches which controller (controllers/households.js).
   There is deliberately no DELETE: records are kept for regulatory retention.
     GET  /api/households              client list
     POST /api/households              create            201 {id, version}; 409 when the firm already
                                       has a household with that client reference
                                       with an Idempotency-Key header, a repeat within a day gets
                                       the first reply (no second household); a bad key is 400
     GET  /api/households/:id          the record        404 if unknown
     PUT  /api/households/:id          save {version, state}   200 {version, changes} | 404 | 409
     GET  /api/households/:id/audit    audit trail, newest first   404 if unknown
   An :id that is not a uuid is 404. Returns a promise of true when it handled the request, false
   when the path is not one of these. */
'use strict';
const { createRouteTable } = require('./table.js');
const { createHouseholdController } = require('../controllers/households.js');

function createHouseholdRoutes({ households, ID_RE, send, readBody }) {
  const c = createHouseholdController({ households, send, readBody });
  return createRouteTable([
    { path: '/api/households', methods: { GET: c.list, POST: c.create } },
    { path: /^\/api\/households\/([^/]+)\/audit$/, params: ['id'], ids: ['id'], methods: { GET: c.audit } },
    { path: /^\/api\/households\/([^/]+)$/, params: ['id'], ids: ['id'], methods: { GET: c.get, PUT: c.save } },
  ], { send, ID_RE });
}

module.exports = { createHouseholdRoutes };
