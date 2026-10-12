# Working on this repository

Umesh owns the repository and decides what is released. Everyone else works through pull requests.

## Day-to-day changes

1. Start from an up-to-date `main`: `git checkout main && git pull`. Once per clone, turn on the
   pre-commit check: `git config core.hooksPath .githooks` (it runs the tests and refuses `.env` and data folders).
2. Create a branch named for the change: `git checkout -b fix/ni-number-check`.
3. Make the change. Run `npm test` before every commit; all tests must pass.
   If you changed `packages/core/core.js`, also run `npm run sync:supabase` and commit the copied file.
   If you changed the interface (`apps/web`), also run `npm run screens` (needs Chrome or Edge) and
   go through [docs/checklists/screen-smoke.md](docs/checklists/screen-smoke.md).
4. Push the branch and open a pull request on GitHub. Say what changed and why, and how you tested it.
5. Umesh reviews and merges. Do not push directly to `main` or merge your own pull request.

## Keeping the app healthy

- **Tests:** `npm test` runs the rules (`test/unit`), the API in both storage modes (`test/api`), database migrations (`test/db`) and the Supabase edition. Set `TEST_DATABASE_URL` to an empty scratch database to include the PostgreSQL tests; never point it at a real database. Add a test with every fix.
- **Dependencies:** the only runtime dependency is `pg` (used only when `DATABASE_URL` is set). Development dependencies are PGlite (tests) and esbuild (bundles the interface's modules for `npm run build`; never shipped). Keep it that way unless agreed.
- **Tax year:** the bands and allowances in `packages/core/core.js` (`assumptions` defaults) need checking against HMRC each April.
- **Spreadsheet library:** see the README (step 5 under Deploy) for the patched SheetJS version.
- **Secrets:** never commit `.env`, `AUTH_USERS`, `DATA_KEY` or Supabase keys. `.gitignore` covers the usual files, but check `git status` before committing.
- **Client data:** never put real client data in the repository, in tests, or in the sample household.

## Releases

Deployments are run by Umesh from `main`. If a change needs a new environment variable or a database migration, say so in the pull request. Database changes go in a new migration file (`db/migrations/NNNN_name.sql` or `supabase/migrations/<timestamp>_name.sql`); never edit one that has been applied.
