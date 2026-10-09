# Working on this repository

Umesh owns the repository and decides what is released. Everyone else works through pull requests.

## Day-to-day changes

1. Start from an up-to-date `main`: `git checkout main && git pull`.
2. Create a branch named for the change: `git checkout -b fix/ni-number-check`.
3. Make the change. Run `npm test` before every commit; all tests must pass.
   If you changed `public/core.js`, also run `npm run sync:supabase` and commit the copied file.
4. Push the branch and open a pull request on GitHub. Say what changed and why, and how you tested it.
5. Umesh reviews and merges. Do not push directly to `main` or merge your own pull request.

## Keeping the app healthy

- **Tests:** `npm test` runs the tax engine, KYC rules, server security and Supabase-edition suites. Add a test with every fix.
- **Dependencies:** there are no runtime dependencies. The only development dependency is PGlite (tests). Keep it that way unless agreed.
- **Tax year:** the bands and allowances in `public/core.js` (`assumptions` defaults) need checking against HMRC each April.
- **Spreadsheet library:** see the README (step 4 under Deploy) for the patched SheetJS version.
- **Secrets:** never commit `.env`, `AUTH_USERS`, `DATA_KEY` or Supabase keys. `.gitignore` covers the usual files, but check `git status` before committing.
- **Client data:** never put real client data in the repository, in tests, or in the sample household.

## Releases

Deployments are run by Umesh from `main`. If a change needs a new environment variable or a database migration, say so in the pull request.
