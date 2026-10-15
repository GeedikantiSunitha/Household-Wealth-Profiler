/* GET /api/me: who is signed in (controllers/me.js). */
'use strict';
const { createRouteTable } = require('./table.js');
const { createMeController } = require('../controllers/me.js');

function createMeRoute({ send, encrypted, production = false }) {
  const c = createMeController({ send, encrypted, production });
  return createRouteTable([
    { path: '/api/me', methods: { GET: c.me } },
  ], { send });
}

module.exports = { createMeRoute };
