#!/usr/bin/env node
/* npm start --workspace backend: the back end on its own, the API without the screens (SERVE_WEB=0),
   the way it runs as its own service. The screens then come from the front end
   (npm start --workspace frontend), which passes /api/ here. A SERVE_WEB already set wins.
   Everything else is as `node server.js` (settings from the environment and the project's .env). */
'use strict';
if (process.env.SERVE_WEB === undefined) process.env.SERVE_WEB = '0';
require('../src/main.js').main(process.argv.slice(2));
