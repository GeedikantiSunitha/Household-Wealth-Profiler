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
