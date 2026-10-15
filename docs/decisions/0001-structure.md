# 0001: One structure for front end, backend, database and rules

- **Date:** 2026-10-10
- **Status:** Accepted for the `feature/restructure` branch; final approval by Umesh in the pull request
- **Baseline:** tag `baseline-before-restructure`

## Context

The app works, but its code is hard to maintain and review safely:

- The backend is one file (`server.js`), and so is the front end (`public/app.js`, about 870 lines).
- There are two backends doing the same job: `server.js` and the Supabase Edge Function.
- The business rules (`core.js`) exist in two copies kept in step by a script.
- Deploy files exist for platforms that will not be used.

The chosen direction is a Node.js API with a PostgreSQL database we manage, with the app
deployed on DCDeploy. How people sign in is still to be decided.

## Decision

Reorganise the code into one structure with clear layers, **without changing behaviour**:

| Folder | Role |
| --- | --- |
| `packages/core/` | Business rules: the only copy |
| `apps/api/` | Backend, in layers (config, http, auth, routes, services, crypto, repositories, db) |
| `apps/web/` | Front end, split into modules |
| `db/migrations/` | Database schema as numbered migrations (done in step B4) |
| `ops/` | Operating tools: data import, backup, restore, admin, keys |
| `deploy/` | Where and how the app runs |
| `docs/` | Architecture, API, data model, environments, checklists, decisions |
| `test/` | Tests grouped by layer |

## Rules while restructuring

1. **Structure first, features after.** Moves and splits only; no new features, no change to
   screens, API replies, saving or the rules.
2. **`core.js` is never edited** during the restructure.
3. **One commit per step**, never a move and a change together; `git mv` keeps file history.
4. **Every step passes:** `npm test` (enforced by the pre-commit hook), the API contract in both
   storage modes, and `npm run screens` reporting `SAME` where screens are affected.
5. **Layers call downwards only.** Only `repositories/` touches storage, only `crypto/` holds
   keys, and only `api/` in the front end calls the backend.
6. **Nothing is deleted** (the Supabase edition, the old deploy files, any data) until a
   separate, approved retirement step.

## Alternatives considered

- **Keep the current layout.** Rejected: two backends and one-file layers make every later
  change (multi-firm support, sign-in, encryption) riskier.
- **Rewrite the front end in React during the restructure.** Rejected for now: changing the
  backend and the front end at the same time multiplies the risk. The module split makes a
  later move possible one screen at a time.
- **Keep the Supabase edition as the backend.** Left open: the chosen direction is a Node API
  with our own PostgreSQL. The Supabase edition stays, untouched, until retirement is decided.

## Consequences

- Each step is small and checked against the baseline, so a problem points to one commit.
- npm workspaces are switched on in step B2, when `packages/core` becomes the first package.
- Documentation and the pull request explain the new layout to Umesh before anything merges.

## Outcome (steps B1 to B21)

Done as planned: `packages/core`, `apps/api` in layers, `apps/web` as browser modules,
`db/migrations`, tests grouped by layer, and the local launcher in `deploy/local`. `core.js` is
unchanged from the baseline. Where the result differs from the plan above:

- **Two deliberate behaviour changes**, each in its own commit and kept out of the moves:
  - The served app saves client data only on the server. If the server cannot be reached, it shows an error instead of quietly saving in the browser. Browser-only saving remains only in the single-file demo build.
  - The Supabase migrations can also run on plain PostgreSQL 14+.
- **One accepted difference in B10:** a malformed request body with no length or chunking now
  gets Node's own 400 reply instead of a 404. Every valid request is answered exactly as before.
- **`import-files` stays in `apps/api/src/cli`**, not `ops/`. It is built on the API's own
  storage code, so moving it would make operations tooling depend on the API's internals.
- **`docs/` holds only decisions and the screen checklist.** Architecture, API and data-model
  pages were not added; the READMEs in each folder and the API contract test cover them.
- **Not yet done:** the `ops/` tools (backup, restore, admin, keys) and `deploy/dcdeploy/` are
  planned in `ops/README.md` and `deploy/README.md` but not built. The Supabase edition and the old deploy files are untouched, pending their own
  retirement decision.
- **Caught up with Umesh's `main` (B24).** His seven feature commits of 2026-10-11 (grouped
  navigation, team tasks and firm settings, letters of authority, the risk questionnaire,
  life-event scenarios, the fund library) were merged and carried into the new structure. Each
  interface change went into its module unchanged, checked declaration by declaration against
  his `app.js`; his server changes went into the API layers. The merged branch was compared with
  his `main`: HTTP replies, stored files, screens and the single-file page all match, apart from the
  module files themselves. Firm settings also gained PostgreSQL storage (`db/migrations/0002`),
  because his `main` stores them in files only.
- **The unit tests run on a fixed clock** (2026-10-10). One of them had hard-coded dates and began
  failing on 2026-10-12; the fix touched only the tests.

## Update 2026-10-15: the middleware layer

The API's security checks, until now written inline in `app.js`, are a layer of their own,
`apps/api/src/middleware/`, with one file per check and a fixed order that `app.js` runs and
`test/api/app.test.js` and `test/api/middleware.test.js` pin: parse-url, health, api-only,
authenticate, sign-in-required, second-step, firm-required, same-site, json-body, csrf. The
per-route guards (`guards.js`: the stage a sign-in route needs, the per-address rate limit, the
role an action needs) sit beside them; the sign-in routes run theirs from their route table. The
HTTP Basic provider (development only) and the rate limiter moved into the layer unchanged.
Behaviour, replies and the route table are the same; the move is the whole change. Field
validation stays in `services/validate.js`, applied by the services, so the commands and the
importer are held to the same rules as the API. With `SERVE_WEB=0` the API answers `/api/`
only and the screens are served by a web tier on the same domain, the first step towards
running the front end, the API and the database as separate services.
