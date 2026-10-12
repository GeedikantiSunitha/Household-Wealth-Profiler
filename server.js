#!/usr/bin/env node
/* Household Wealth Profiler server. Node 22+; the "pg" package only when DATABASE_URL is set.
   - Serves the app from ./public
   - Named logins (HTTP Basic over HTTPS) with scrypt-hashed passwords
   - Client files encrypted at rest with AES-256-GCM (DATA_KEY)
   - Stored as files under DATA_DIR, or in PostgreSQL when DATABASE_URL is set (db/migrations)
   - Every save is versioned; older versions are kept
   - Server-side audit trail: who changed which field, when, from what, to what
   - No delete endpoint: AML records must be kept for 5 years after the relationship ends

   Commands:
     node server.js                          start the server
     node server.js hash-password NAME PASS  print an AUTH_USERS entry
     node server.js gen-key                  print a new DATA_KEY
     node server.js import-files [DIR]       copy file-store households (DATA_DIR) into PostgreSQL

   Settings come from the environment, or from a .env file next to this one.
   Variables already set in the environment win over .env.

   The code is in apps/api/src (start-up: main.js). This file stays so that `npm start`, the
   Dockerfile, the deploy scripts and the commands above keep working unchanged.
*/
'use strict';
if (require.main === module) require('./apps/api/src/main.js').main(process.argv.slice(2));
