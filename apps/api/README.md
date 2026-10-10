# apps/api: backend (Node.js)

The server: settings, sign-in, encryption, storage, the household API and the audit trail.

**Fills in steps B5 to B11**, when `server.js` is split into layers here, one layer per step.
`server.js` at the project root stays as a one-line pointer until then, so `npm start`, the
Dockerfile and the `node server.js …` commands keep working.

## Layers (each calls only the one below it)

| Folder | Holds |
| --- | --- |
| `src/config/` | Reads and checks every setting; refuses to start when one is missing or wrong |
| `src/http/` | Router, body limits, security headers, error replies, static files |
| `src/auth/` | Sign-in (today: Basic, under `providers/basic/`) |
| `src/routes/` | One file per route group; reads input, calls one service, replies |
| `src/services/` | The work, using `packages/core`: normalise, diff, summarise, create, save |
| `src/crypto/` | Encrypt and decrypt records; the only place that holds keys |
| `src/repositories/` | The only place with storage code (files or SQL) |
| `src/db/` | Connection pool, transactions, running `db/migrations` |
| `src/cli/` | `hash-password`, `gen-key`, `import-files` |

The API's replies are fixed by `test/api/api-contract.js`; every step keeps it passing.
