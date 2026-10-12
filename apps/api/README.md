# apps/api: backend (Node.js)

The server: settings, sign-in, encryption, storage, the household API and the audit trail.

It was split out of the original single `server.js` (steps B5 to B11) without changing what the
API does. `server.js` at the project root is now a one-line pointer to `src/main.js`, so
`npm start`, the Dockerfile and the `node server.js …` commands work as before.

## Layers (each calls only the ones below it)

| Path | Holds |
| --- | --- |
| `src/main.js` | Start-up: loads the settings, builds each layer, starts listening; runs the commands |
| `src/app.js` | The request pipeline, in order: `/healthz`, sign-in, static files, the write check, routes, 404 |
| `src/config/` | Reads `.env` (never overriding the environment) and checks every setting; refuses to start when one is missing or wrong |
| `src/http/` | Security headers, JSON replies and body limits (`respond.js`), static files (`static.js`), the same-site and JSON check on writes (`guards.js`) |
| `src/auth/` | Sign-in: Basic, under `providers/basic/` (scrypt hashes, lockout after 10 failures for 15 minutes) |
| `src/routes/` | One file per route group (`me.js`, `households.js`); reads input, calls the service, replies |
| `src/services/` | The work, using `packages/core`: normalise, diff, summarise, create, save. Knows nothing about HTTP |
| `src/crypto/` | Encrypts and decrypts records (AES-256-GCM); the only code that holds `DATA_KEY` |
| `src/repositories/` | The only storage code: the file store and the PostgreSQL store, behind one interface |
| `src/db/` | The PostgreSQL pool and transactions; applies any new `db/migrations` (via `db/migrate.js`) at start-up |
| `src/cli/` | `hash-password`, `gen-key`, `import-files` |

## Rules

- Rules and calculations come from `packages/core`; nothing here re-implements them.
- Settings come only from `src/config/`; no other file reads `process.env`.
- The API's replies are fixed by `test/api/api-contract.js`, which runs against both the file store
  and PostgreSQL. A change that alters a reply is a behaviour change: it needs its own commit and
  tests, and the pull request says so.
