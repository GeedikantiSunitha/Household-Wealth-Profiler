# Working on this repository

Umesh owns the repository and decides what is released. Everyone else works through pull requests.

## Day-to-day changes

1. Start from an up-to-date `develop`: `git checkout develop && git pull`. Once per clone, turn on the
   pre-commit check: `git config core.hooksPath .githooks` (it runs the tests and refuses `.env` and data folders).
2. Create a branch named for the change: `git checkout -b fix/ni-number-check`.
3. Make the change. Run `npm test` and `npm run check` before every commit; all must pass.
   If you changed `packages/core/core.js`, also run `npm run sync:supabase` and commit the copied file.
   If you changed the interface (`apps/web`), also run `npm run screens` (needs Chrome or Edge) and
   go through [docs/checklists/screen-smoke.md](docs/checklists/screen-smoke.md).
4. Push the branch and open a pull request into `develop`. Say what changed and why, and how you tested it.
   The checks in `.github/workflows/ci.yml` must pass: tests with PostgreSQL, the single-file build, the
   screen check, migrations that only add, allowed licences, `npm audit`, a secret scan, and the container scan.
5. A change to `packages/core/core.js` (the business rules) is a **rules change**: add the `rules-change`
   label and name the compliance sign-off in the pull request, or the `change-control` check fails.
   Paths listed in `.github/CODEOWNERS` need Umesh's review.
6. Umesh reviews and merges. `develop` goes into `main` by pull request only, when a release is agreed.
   Do not push directly to `develop` or `main`, and do not merge your own pull request.

## Branch protection (repository owner, once)

For both `develop` and `main`, in Settings > Branches: require a pull request before merging; require
review from Code Owners; require these status checks to pass: `test`, `change-control`, `security`,
`container` (and `analyze` once CodeQL is enabled); block force pushes; apply the rules to administrators.
Create the `rules-change` label. On a private repository CodeQL needs GitHub Advanced Security; enable it
by setting the repository variable `CODEQL` to `1`.

## Keeping the app healthy

- **Tests:** `npm test` runs the rules (`test/unit`), the API in both storage modes (`test/api`), database migrations (`test/db`) and the Supabase edition. Set `TEST_DATABASE_URL` to an empty scratch database to include the PostgreSQL tests; never point it at a real database. Add a test with every fix.
- **Dependencies:** the only runtime dependency is `pg` (used only when `DATABASE_URL` is set). Development dependencies are PGlite (tests) and esbuild (bundles the interface's modules for `npm run build`; never shipped). Keep it that way unless agreed.
- **Tax year:** the bands and allowances in `packages/core/core.js` (`assumptions` defaults) need checking against HMRC each April.
- **Spreadsheet library:** see the README (step 5 under Deploy) for the patched SheetJS version.
- **Secrets:** never commit `.env`, `AUTH_USERS`, `DATA_KEY` or Supabase keys. `.gitignore` covers the usual files, but check `git status` before committing.
- **Client data:** never put real client data in the repository, in tests, or in the sample household.

## Releases

Deployments are run by Umesh from `main`. If a change needs a new environment variable or a database migration, say so in the pull request. Database changes go in a new migration file (`db/migrations/NNNN_name.sql` or `supabase/migrations/<timestamp>_name.sql`); never edit one that has been applied.

Migrations only add. `npm run check` refuses any statement that drops, deletes or truncates; records are
kept for regulatory retention. The one exception, an approved erasure, carries
`-- allow-destructive: <reason and approver>` on the line before the statement, and the pull request names the approval.
