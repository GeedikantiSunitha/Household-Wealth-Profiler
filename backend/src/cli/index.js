/* Commands that need no settings:
     node server.js hash-password NAME PASSWORD   print an AUTH_USERS entry
     node server.js gen-key                       print a new DATA_KEY (32 random bytes, base64)
   Each returns the exit code; output goes to stdout, problems to stderr. */
'use strict';
const crypto = require('crypto');
const { hashPassword } = require('../middleware/authenticate.js');

function hashPasswordCommand([name, pass]) {
  if (!name || !pass || /[:;]/.test(name)) { console.error('Usage: node server.js hash-password NAME PASSWORD (name without : or ;)'); return 1; }
  console.log(hashPassword(name, pass));
  return 0;
}

function genKeyCommand() {
  console.log(crypto.randomBytes(32).toString('base64'));
  return 0;
}

module.exports = { hashPasswordCommand, genKeyCommand };
