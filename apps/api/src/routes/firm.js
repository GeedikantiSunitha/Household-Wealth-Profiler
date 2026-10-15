/* Firm settings routes, for the signed-in user's firm: which method and path reaches which
   controller (controllers/firm.js). There is no DELETE: every version and audit entry is kept.
     GET /api/firm          the firm settings record (version 0 before the first save)
     PUT /api/firm          save {version, settings}   200 {version, changes} | 409
     GET /api/firm/audit    audit trail, newest first
   Returns a promise of true when it handled the request, false when the path is not one of these. */
'use strict';
const { createRouteTable } = require('./table.js');
const { createFirmController } = require('../controllers/firm.js');

function createFirmRoutes({ firm, send, readBody }) {
  const c = createFirmController({ firm, send, readBody });
  return createRouteTable([
    { path: '/api/firm', methods: { GET: c.get, PUT: c.save } },
    { path: '/api/firm/audit', methods: { GET: c.audit } },
  ], { send });
}

module.exports = { createFirmRoutes };
