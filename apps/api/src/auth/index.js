/* Sign-in for the API. One provider today (HTTP Basic); a future provider (two-step sign-in, or an
   identity service) plugs in here with the same authenticate(req) shape, without touching routes. */
'use strict';
const basic = require('./providers/basic');

function createAuth(config, options = {}) {
  return basic.createBasicAuth({ users: config.users, clientIpHeader: config.clientIpHeader, ...options });
}

module.exports = { createAuth, hashPassword: basic.hashPassword };
