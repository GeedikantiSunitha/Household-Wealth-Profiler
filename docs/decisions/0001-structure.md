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
| `backend/` | Backend, in layers (config, http, auth, routes, services, crypto, repositories, db) |
| `frontend/` | Front end, split into modules |
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

Done as planned: `packages/core`, `backend` in layers, `frontend` as browser modules,
`db/migrations`, tests grouped by layer, and the local launcher in `deploy/local`. `core.js` is
unchanged from the baseline. Where the result differs from the plan above:

- **Two deliberate behaviour changes**, each in its own commit and kept out of the moves:
  - The served app saves client data only on the server. If the server cannot be reached, it shows an error instead of quietly saving in the browser. Browser-only saving remains only in the single-file demo build.
  - The Supabase migrations can also run on plain PostgreSQL 14+.
- **One accepted difference in B10:** a malformed request body with no length or chunking now
  gets Node's own 400 reply instead of a 404. Every valid request is answered exactly as before.
- **`import-files` stays in `backend/src/cli`**, not `ops/`. It is built on the API's own
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
`backend/src/middleware/`, with one file per check and a fixed order that `app.js` runs and
`backend/test/api/app.test.js` and `backend/test/api/middleware.test.js` pin: parse-url, health, api-only,
authenticate, sign-in-required, second-step, firm-required, same-site, json-body, csrf. The
per-route guards (`guards.js`: the stage a sign-in route needs, the per-address rate limit, the
role an action needs) sit beside them; the sign-in routes run theirs from their route table. The
HTTP Basic provider (development only) and the rate limiter moved into the layer unchanged.
Behaviour, replies and the route table are the same; the move is the whole change. Field
validation stays in `services/validate.js`, applied by the services, so the commands and the
importer are held to the same rules as the API. With `SERVE_WEB=0` the API answers `/api/`
only and the screens are served by a web tier on the same domain, the first step towards
running the front end, the API and the database as separate services.

## Update 2026-10-15: routes, controllers, services, repositories

The route files are now tables only (`routes/table.js` runs them: method and path to a
controller, the route's parameters and id checks, its guards in order, 405 where the API has
always said so). The handler bodies moved, unchanged, into `backend/src/controllers/`, one file
per route file, including the sign-in handlers from `routes/auth.js`, whose route table stays
where it was. The direction is now the rule and `backend/test/ci/layers.test.js` enforces it on every
`require()`: app.js to middleware and routes, routes to controllers, controllers to services,
services to repositories, repositories to the database; no layer requires one above it, and a
route never skips the controller to call a service.

## Update 2026-10-15: the auth folder dissolved into the layers

`backend/src/auth/` held both decisions and storage. Its files moved, unchanged, to where the
layers say: `services/auth/` (password, sessions, totp, invites, notify, mail) and
`repositories/auth-store.js` (accounts, sessions and the auth event log in PostgreSQL). The
progressive-delay schedule after failed sign-ins now lives with the store that applies it, and
the password service re-exports it, so no repository requires a service. The layering test
covers the result.

## Update 2026-10-15: the front end in layers

`frontend/src/js` is now pages, components, hooks and services, in that direction: the screens
and the sign-in screens are `pages/`; the side rail and top bar joined `components/`; the state,
the store, the people and firm look-ups and the Excel and download helpers are `hooks/`, what
pages share; `services/api/` is the only code that calls the server (`client.js` for the API,
`auth.js` for the sign-in). Three small edits made the rule true: the store's three network calls
went to `client.js` and its decisions stayed in the store; main.js hands the sign-in pages to the
store instead of the store loading a page; and the balance sheet groups became content, shared
by the page and the Excel export. `frontend/test/ci/web-layers.test.js` enforces the direction and the
fetch rule. Every screen is unchanged. (The screen check's own requires of the moved sign-in
services, missed by the previous commit, are corrected here.)

## Update 2026-10-16: the Supabase edition retired (Phase 6)

The second backend is gone: `supabase/` (its migrations, the Edge Function and its copy of
`core.js`), `scripts/firms.js`, `scripts/deploy-supabase.sh`, `scripts/supabase-db.js`,
`scripts/build-web.js`, the browser's `cloud.js` and `config.js`, the `sync:supabase` and
`build:web` scripts and the Supabase test. The browser's one dead branch (the cloud sign-in and
bearer token in the store, the API client and the sign-out action) went with it, so
`services/api` is now the whole truth of how the front end reaches the server. The migration
runner tracks one table. `packages/core/core.js` is untouched and is now the only copy of the
rules. Every screen is unchanged; the full suite and the screen check are the proof.

## Update 2026-10-16: frontend/ and backend/, and the front end built from src to dist

The folders carry the names the company's other applications use: `apps/web/public` is now
`frontend/src`, `apps/api` is `backend`, moved with `git mv` so history follows; every path in the
code, the tests, the Dockerfiles, the compose file and the documents was updated, and the five paths
that climbed to the repository root are one level shorter. The front end gained a build,
`scripts/build-web.js`: `frontend/src` becomes `frontend/dist`, with `core.js` (from
`packages/core`) and the pinned libraries copied byte for byte and `js/main.js` bundled and minified
by esbuild as ES modules with no inline code, so the content security policy is unchanged. In
development the server still serves `frontend/src` as it is; `WEB_DIR=frontend/dist` serves the
build, which is what `frontend/Dockerfile` puts in nginx. The screen check passes against both.
The back end still answers the same domain through the web tier's proxy: no cross-origin calls, no
CORS. Behaviour, replies and screens are unchanged.

## Update 2026-10-19: the split-address mode

The default stays one address: the front end's nginx passes `/api/` to the back end, so the browser
sees one site and the session cookie is `SameSite=Strict`. At the request of the owner, who wants the
shape the company's other applications use, there is now an option: `FRONTEND_ORIGIN` on the back end
and `API_BASE_URL` on the front end put the two on separate addresses, the browser calling the back end
directly. It is off unless set. The back end gains the `cors` gate (second after health: it answers
the preflight for `/api/` and lets only the listed origins read replies, never `*`), the same-site gate
accepts a write from a listed origin, and the session cookie takes the `SameSite` the settings ask for
(`None` only with `Secure`). The front end reads its one run-time setting from `runtime-config.js`
(empty by default; the web tier's container writes it from `API_BASE_URL`), and its content security
policy allows exactly that address. The cost, recorded: `Strict` holds only while the two addresses are
one site, and third-party-cookie blocking can break sign-in on two unrelated addresses, so two
subdomains of one owned domain with `SESSION_SAMESITE=strict` is the recommended form. Proof: the
screen check passes 59 of 59 in both modes, the second with the two servers on two ports in a real browser.
