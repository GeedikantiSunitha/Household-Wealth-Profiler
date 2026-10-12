# apps/api: backend (Node.js)

The server: settings, sign-in, encryption, storage, the household API and the audit trail.

It was split out of the original single `server.js` (steps B5 to B11) without changing what the
API does. `server.js` at the project root is now a one-line pointer to `src/main.js`, so
`npm start`, the Dockerfile and the `node server.js …` commands work as before.

## Layers (each calls only the ones below it)

| Path | Holds |
| --- | --- |
| `src/main.js` | Start-up: loads the settings, builds each layer, starts listening; runs the commands. On SIGTERM it lets requests in flight finish, then exits |
| `src/app.js` | The request pipeline, in order: `/healthz` and `/readyz` (storage answers), sign-in, static files, the write check, routes, 404 |
| `src/config/` | Reads `.env` (never overriding the environment) and checks every setting; refuses to start when one is missing or wrong. With `NODE_ENV=production` it also refuses the file store, plaintext storage, plain HTTP and Basic sign-in |
| `src/http/` | Security headers, JSON replies and body limits (`respond.js`), static files (`static.js`), the same-site and JSON check on writes (`guards.js`) |
| `src/auth/` | Sign-in: Basic, under `providers/basic/` (scrypt hashes, lockout after 10 failures for 15 minutes) |
| `src/routes/` | One file per route group (`me.js`, `households.js`, `firm.js`, `prices.js`); reads input, calls the service with the sign-in context `{ user, firmId }`, replies |
| `src/services/` | The work, using `packages/core`: households (normalise, diff, summarise, create, save; a duplicate client reference is refused), firm settings (versioned and audited the same way), fund prices from Alpha Vantage when `ALPHAVANTAGE_KEY` is set. Every call is for one firm. Knows nothing about HTTP |
| `src/crypto/` | Encrypts and decrypts records (AES-256-GCM): each firm has its own data key, stored wrapped by `DATA_KEY`; the keyed index of client references. The only code that holds keys |
| `src/repositories/` | The only storage code: the file store (development) and the PostgreSQL store, behind one interface. `forFirm(firmId)` gives a store that sees that firm alone; in PostgreSQL every call sets `app.firm_id` for its transaction and row-level security does the rest |
| `src/db/` | The PostgreSQL pool and transactions; migrations through `db/migrate.js` (development applies them at start-up; production refuses to start while one is pending) |
| `src/cli/` | `hash-password`, `gen-key`, `import-files`, `migrate` (as the owner), `index-references` |

## Rules

- Rules and calculations come from `packages/core`; nothing here re-implements them.
- Settings come only from `src/config/`; no other file reads `process.env`.
- The API's replies are fixed by `test/api/api-contract.js`, which runs against both the file store
  and PostgreSQL. A change that alters a reply is a behaviour change: it needs its own commit and
  tests, and the pull request says so.
