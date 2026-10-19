#!/usr/bin/env node
/* npm start --workspace backend: the back end on its own, the API without the screens (SERVE_WEB=0),
   the way it runs as its own service, on port 3001 (the front end's development server passes /api/
   here: npm start --workspace frontend). A SERVE_WEB or PORT already given wins: in the environment, or
   in the back end's .env file (backend/.env, else the project root's .env), as for every setting.
   Everything else is as `node server.js` (npm start at the root keeps port 8080: screens and API together). */
'use strict';
const fs = require('fs');
const util = require('util');
const { envFileOf, ROOT } = require('../src/config');

const BACKEND_PORT = '3001';

// The defaults for the back end alone, unless the environment or the .env file already says otherwise
function backendDefaults(env = process.env, file = envFileOf(ROOT)) {
  const inFile = fs.existsSync(file) ? util.parseEnv(fs.readFileSync(file, 'utf8')) : {};
  if (env.SERVE_WEB === undefined && inFile.SERVE_WEB === undefined) env.SERVE_WEB = '0';
  if (env.PORT === undefined && inFile.PORT === undefined) env.PORT = BACKEND_PORT;
  return env;
}

module.exports = { backendDefaults, BACKEND_PORT };

if (require.main === module) {
  backendDefaults();
  require('../src/main.js').main(process.argv.slice(2));
}
