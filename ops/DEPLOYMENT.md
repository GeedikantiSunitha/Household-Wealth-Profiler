# Household Wealth Profiler: deployment process

**Version:** 1.0
**Last updated:** 16 October 2026
**Applies to:** the Node API edition on `develop` and later (`backend`, `frontend`, `db/migrations`); the former Supabase edition was retired in Phase 6, so "Supabase" below means only the PostgreSQL host option.

Step-by-step instructions for deploying to development, staging and production, with the checks before, the validation after, and how to roll back. Everything here is what the code actually does; where a step is still to be decided, it says so.

---

## 1. Overview

### Environments

| Environment | Where | Database | Sign-in |
|---|---|---|---|
| Development | your own machine, `npm start` or `npm run dev` | local PostgreSQL (`wealth_profiler`) or the file store | the app's own sign-in, or HTTP Basic with `npm run dev` |
| Staging | DCDeploy service built from branch `develop` | PostgreSQL with the three roles (Supabase London or your own server) | the app's own sign-in, second step optional |
| Production | DCDeploy service built from branch `main` | PostgreSQL with the three roles, paid tier, backups | the app's own sign-in, second step required |

### Branch flow

```
feature branch (one per approved phase) → develop (staging) → main (production)
```

`develop` lives on both GitHub repositories (yours and Umesh's). `main` is promoted from `develop` by a pull request, never by a direct push.

### What a deployment is

Two shapes, same code, same database:

- **One service** (the simplest): the repository's root `Dockerfile` (Node 22, port 8080) serves the API and the screens together.
- **Two services** (the front end apart from the back end, as in the ModelMyWealth and mahimapareek deployments): `frontend/Dockerfile` is an nginx container serving `frontend/src` and `core.js` as they are and passing `/api/`, `/healthz` and `/readyz` to the API; `backend/Dockerfile` is the API alone (`SERVE_WEB=0`). Only the web tier faces the internet. One domain for both, so the session cookie, the CSRF token, the same-site check and the content security policy are unchanged; the web tier sends the same page headers the API does, and a test pins that.

In both shapes the PostgreSQL database is a separate service, migrations are run from your machine before the deploy, and the production server refuses to start while one is pending. There is no volume: with `DATABASE_URL` set, nothing is written to disk. `deploy/local/compose.yml` rehearses the two-service shape on your own machine, and `deploy/local/check.js` is the smoke check for either shape.

---

## 2. Pre-deployment checklist

### Code quality

- [ ] `npm run check` (migrations only add; every runtime package licence is allowed)
- [ ] Full suite with PostgreSQL on a scratch cluster, one suite at a time, three test files at a time on a low-memory machine:
  ```sh
  TEST_DATABASE_URL=postgres://postgres@localhost:5498/hwp_test node --test --test-timeout=300000 --test-concurrency=3 "test/**/*.test.js"
  ```
  Expected: 0 fail, 0 cancelled (1 skipped on Windows: the signal test). The database name must end in `_test`.
- [ ] Screen check in both modes, no `FAIL`:
  ```sh
  npm run screens                                              # Basic mode
  TEST_DATABASE_URL=postgres://... npm run screens -- session  # the app's own sign-in, registration, roles
  ```
- [ ] `packages/core/core.js` byte-identical to Umesh's `main` (`public/core.js` there):
  ```sh
  git diff --quiet origin/main:public/core.js HEAD:packages/core/core.js && echo identical
  ```
- [ ] No applied migration edited (the runner refuses a changed checksum; new changes go in a new numbered file)
- [ ] Code reviewed; `README.md` and `docs/decisions/` updated for anything that changed behaviour
- [ ] CI green on GitHub (`.github/workflows`: tests on PostgreSQL, change control, CodeQL, licence and migration guards)

### Known issue to watch

Under full-suite load the `import-files` test fails in roughly half of default-parallelism runs with a connection reset, and once a subject-access request answered 503. Both pass alone and at concurrency 3. Recorded as a Phase 5 item (server behaviour under pool pressure); not a deploy blocker, but a failed run is not evidence: rerun.

### Environment preparation

- [ ] Database created with the three roles (section 4)
- [ ] Migrations applied from your machine (section 5)
- [ ] `grant-operator` run after any migration that adds tables
- [ ] Variables set on the DCDeploy service (section 6)
- [ ] `DATA_KEY` generated once and kept in the password manager; losing it means losing the records
- [ ] Mail domain verified at Resend; a test email received
- [ ] Production only: database backup taken before the deploy (section 8); DCDeploy's and the database host's data processing agreements on file

---

## 3. Development

### Prerequisites

Node.js 22 or later (24 is used locally); PostgreSQL 14 or later for the database mode; Chrome or Edge for the screen check.

### Steps

```sh
git checkout develop
git pull sunitha develop
npm install
cp .env.example .env     # then fill in (never commit .env; never print a key)
```

Two ways to run:

- `npm run dev`: file store, no encryption, demo login `demo` / `demo`, data in `./data-dev`. For trying the screens only.
- `npm start`: reads `.env`; with `DATABASE_URL` it uses PostgreSQL and the app's own sign-in, and applies new migrations itself at start-up (development only).

A second instance on another port: `PORT=8081 node server.js`. With `TOTP_REQUIRED=0` the password alone signs in.

### Verify

- http://localhost:8080/healthz → `{"ok":true}`
- http://localhost:8080/readyz → `{"ok":true}` once the database answers
- http://localhost:8080 → the sign-in page

---

## 4. The database

### Roles

The app uses three PostgreSQL roles, created once by a database administrator, never by a migration:

| Role | Used by | May |
|---|---|---|
| `hwp_owner` | `node server.js migrate`, `grant-operator`, `rotate-key`, `check-records`, `subject-access-user` | own the tables and change the schema |
| `hwp_app` | the server (`DATABASE_URL`) | read and write one firm's rows per transaction; row-level security is forced on every table and cannot be bypassed |
| `hwp_operator` | `firm-create`, `firm-list`, `firm-seats`, `firm-status`, `access-review`, `create-user`, `set-password` | firms, accounts and memberships; never a client record, key or secret |

Create them on a host where you are allowed to (Supabase's `postgres` user can; DCDeploy's managed login cannot):

```sql
create role hwp_owner    login password '...' nosuperuser nobypassrls nocreatedb nocreaterole;
create role hwp_app      login password '...' nosuperuser nobypassrls nocreatedb nocreaterole;
create role hwp_operator login password '...' nosuperuser nobypassrls nocreatedb nocreaterole;
grant usage  on schema public to hwp_owner, hwp_app, hwp_operator;
grant create on schema public to hwp_owner;
```

Three different long random passwords, kept in the password manager. Passwords with `@`, `#`, `/` or `%` must be URL-encoded inside a connection string; base64url passwords avoid the problem.

### Connection strings

Over TLS whenever the database is on another machine. The pg driver verifies the certificate against Node's own store:

```
postgresql://hwp_app:PASSWORD@HOST:5432/DBNAME?sslmode=verify-full
```

If the host's certificate is not from a public authority (Supabase), add its CA, which is in the image:

```
...?sslmode=verify-full&sslrootcert=/app/db/certs/prod-ca-2021.crt
```

Supabase: use the **Session pooler** string (port 5432, works over IPv4) with the user written as `hwp_app.PROJECTREF`; the database is `postgres`.

### DCDeploy's managed PostgreSQL: single-login mode

Its single login cannot create roles, so the three-role layout cannot be set up there. For it the app has **single-login mode**, `DB_LOGIN_MODE=single` (the ModelMyWealth design, README "Single-login mode"): the one login owns the tables, runs the migrations and is the app's connection; it must not be a superuser or bypass row-level security, which the server checks at start-up; every table forces row-level security, so the policies bind the owner too. The migration files are unchanged: `db/single-login.js` applies them with role creation and grants left out and the owner's policies behind operator and maintenance modes, which commands switch on for their own connection and the server never does. `DATABASE_OWNER_URL` and `DATABASE_OPERATOR_URL` stay unset in this mode.

What it gives up, as MMW does: the login owns the tables, so a policy or trigger could in principle be switched off by code; that rests on the application. Firm isolation, the retention triggers and the two-person purge are unchanged. Backups come from the host, because the login cannot read every firm's rows for the backup command.

DCDeploy's database also has **no TLS**: reach it over DCDeploy's private network only, and leave its public TCP proxy off.

Check any login before relying on it, and run the posture check before every deploy:

```sql
select rolsuper, rolbypassrls, rolcreatedb from pg_roles where rolname = current_user;
```

```sh
DB_LOGIN_MODE=single node server.js check-db-posture   # exit 0 only when every check passes
```

A login with `rolsuper` or `rolbypassrls` true would make every row-security policy inert, and the server refuses to start on one.

---

## 5. Migrations

`db/migrations/NNNN_name.sql`, applied in order by `node server.js migrate` as the owner. Each file runs in its own transaction with its tracking row and checksum; an advisory lock serialises concurrent runs; a changed applied file is refused. Migrations only add (the CI guard checks), and the retention triggers refuse deletes anyway.

### Before each deploy, from your machine

Never paste a connection string into `.env` or a command line. Prompt for it, so neither the shell history nor a file holds it:

```powershell
$o = Read-Host 'owner connection string' -AsSecureString
$env:DATABASE_OWNER_URL = [System.Net.NetworkCredential]::new('', $o).Password
$a = Read-Host 'app connection string' -AsSecureString
$env:DATABASE_URL = [System.Net.NetworkCredential]::new('', $a).Password
node server.js migrate          # "Applied N migration(s): ..." or "No migrations pending."
node server.js grant-operator   # after any migration that adds tables
Remove-Item Env:DATABASE_OWNER_URL, Env:DATABASE_URL
```

Both variables are needed together: the loader refuses an owner connection whose host or database differs from the app's, and your local `.env` would otherwise fill `DATABASE_URL` in. The local `DATA_KEY` in `.env` satisfies the loader but is not used by `migrate`: no migration binds anything to a key.

### Rules

- Never edit an applied file; the next change goes in a new number.
- Migration 0010 is frozen by decision (13 October 2026). 0015 is registration.
- New migrations name no database role: single-login mode refuses a file with a role reference no rule covers.
- Production applies nothing at start-up: deploy after `migrate`, not before.
- Single-login mode (DCDeploy): `DB_LOGIN_MODE=single node server.js migrate`, then `check-db-posture`, run inside DCDeploy as a one-off worker from the same image in the same environment, because the database is reachable only over its private network. `grant-operator` does not apply (there is no operator role).
- There are no rollback scripts: migrations add only, so older code tolerates a newer schema, and a rollback is a redeploy of the previous commit (section 9).

---

## 6. Staging and production on DCDeploy

### Create the service (one-service shape)

1. Add a service from the GitHub repository (`GeedikantiSunitha/Household-Wealth-Profiler` or `umesh-ttf/household-wealth-profiler`), branch `develop` for staging, `main` for production. Build context and Dockerfile path `./`.
2. Port `8080`. One instance. No volume needed.
3. Set the variables below, then deploy.

### Or two services (front end and back end apart)

1. **api**: same repository and branch; build context `./`, Dockerfile path `backend/Dockerfile`; port `8080`; the variables below. Not reachable from the internet if DCDeploy allows a private service; otherwise note its public address.
2. **web**: same repository and branch; build context `./`, Dockerfile path `frontend/Dockerfile`; port `8080`; this is the public one, with the domain and TLS. Variables: `BACKEND_URL` = the api service's internal address, `http://<internal hostname>:8080` (its internal link; both services in the same environment). Only if the host has no private network: the api service's `https://` address, and then also `API_HOST` = that address's host name. `API_UPSTREAM`, the earlier name, is still accepted. A wrong address stops the web container at start with "host not found in upstream" in its log.
3. `PUBLIC_URL` on the api service is the web service's public address (the one users open), not the api's own.
4. After deploy, `node deploy/local/check.js https://HOST` proves the split: the page and `core.js` byte for byte with the headers, the API behind the same domain, a cross-site write refused, a same-site one reaching the API.

Rehearse first on your machine: `HWP_DATA_KEY=$(node server.js gen-key) docker compose -f deploy/local/compose.yml up --build`, then `node deploy/local/check.js http://localhost:8088`.

### Variables

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | set by the Dockerfile already; keeps the refusals on |
| `DATABASE_URL` | the `hwp_app` connection string, `sslmode=verify-full` (+ `sslrootcert` for Supabase) | the server's only database access |
| `DATA_KEY` | from `node server.js gen-key`, new per environment | never the local one; never reused between staging and production |
| `PUBLIC_URL` | `https://HOST` exactly, no path | the Secure cookie and every emailed link depend on it |
| `SMTP_URL` | `smtps://USER:PASSWORD@smtp.resend.com:465` | TLS from the start; `tls=off` is refused |
| `SMTP_FROM` | `Household Wealth Profiler <no-reply@thetimefintech.com>` | a verified sender domain |
| `PORT` | `8080` | |
| `TOTP_REQUIRED` | `0` on staging if the authenticator step is not wanted yet; unset (required) in production | never `0` with real client data |
| `OPERATOR_EMAIL` | optional | no longer used by the sign-in |
| `CLIENT_IP_HEADER` | only if DCDeploy confirms the header it sets on every request | otherwise every failed sign-in counts against the proxy's address |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `RETENTION_YEARS` | optional | defaults 30, 12, 5 |
| `ALPHAVANTAGE_KEY` | unset | its licence is non-commercial; prices stay off |

Never set on a service: `AUTH_USERS`, `ALLOW_PLAINTEXT`, `HSTS=0` (the server refuses to start), `DATABASE_OWNER_URL`, `DATABASE_OPERATOR_URL` (those belong on your machine only), `BACKUP_*` (those belong to the backup job).

### Order

1. `migrate` and `grant-operator` from your machine (section 5).
2. Deploy the service.
3. `GET /healthz` → `{"ok":true}` at once; `GET /readyz` → `{"ok":true}` once the database answers and no migration is pending. If it stays 503, the logs name the refusal (section 10).
4. First account (below).

### First accounts

Two ways:

- **Registration** on the sign-in page: name, email, firm, password; the verification link arrives by email; sign in. The registrant is the administrator of a new firm and invites colleagues from the Team page.
- **The operator**, from your machine, with the `hwp_operator` string in `DATABASE_OPERATOR_URL` and the `hwp_app` string in `DATABASE_URL` (prompted as in section 5):
  ```powershell
  node server.js firm-create "Firm name" 5
  node server.js create-user you@example.com "Your Name" FIRM_ID admin
  Read-Host 'password' -AsSecureString | % { [System.Net.NetworkCredential]::new('', $_).Password } | node server.js set-password you@example.com
  ```

### Promoting to production

```sh
git checkout main && git pull sunitha main
git merge --no-ff develop          # or the pull request on GitHub
git push sunitha main
```

Then sections 5 and 6 against the production database and service, with a backup taken first (section 8).

---

## 7. Post-deployment validation

### Health

- `https://HOST/healthz` → 200 `{"ok":true}`
- `https://HOST/readyz` → 200 `{"ok":true}`

### Security

- [ ] HTTPS only; `Strict-Transport-Security` present
- [ ] Response headers: `Content-Security-Policy` (`default-src 'self'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
- [ ] The session cookie is `__Host-hwp_session`, Secure, HttpOnly, SameSite=Strict
- [ ] A write without `X-CSRF-Token` is refused (403 `csrf`)
- [ ] A cross-site write is refused (403 `cross_site`)

### Functional

- [ ] Register, receive the link, confirm, sign in; second step and recovery codes where `TOTP_REQUIRED` is not `0`
- [ ] Create a household, edit it, see "All changes saved"; reload and it is there
- [ ] A second account in another firm sees nothing of the first (row-level security)
- [ ] Team page: invite, change a role, deactivate
- [ ] Records page: end a relationship, request a purge, approve it with a different account
- [ ] Subject access export downloads
- [ ] Forgotten password: the link arrives and works once

### Performance

- [ ] First page load under 3 seconds
- [ ] `/readyz` under 500 ms
- [ ] No 503 `busy` in the logs under normal use (pool pressure is a known Phase 5 item)

---

## 8. Backups and the restore drill

Both are commands of the app, run as a job of their own, never inside the server. They need `pg_dump` / `pg_restore` of at least the server's version (`PG_BIN` if not on the PATH).

```sh
node server.js gen-key      # once: BACKUP_KEY, a key of its own, never DATA_KEY
node server.js backup       # BACKUP_DATABASE_URL, BACKUP_DIR, BACKUP_KEY
node server.js restore-drill   # the newest backup; monthly, and after any change to the set-up
```

- `BACKUP_DATABASE_URL` must be a role that reads every row (superuser or `BYPASSRLS`): Supabase's `postgres`, never `hwp_app` or `hwp_owner`, which row security would silently hide rows from. The command refuses otherwise.
- The drill needs `CREATEDB`; if the host's login lacks it, run drills against a local PostgreSQL.
- The dump is encrypted as it streams; a signed manifest records row counts, migrations, triggers and policies. Backups older than `BACKUP_RETENTION_DAYS` (35) are pruned, never the newest.
- Copy `BACKUP_DIR` off the hosting platform. Keep `BACKUP_KEY`, `DATA_KEY` and the backups in three separate places.
- A restore brings back any household purged after the backup was made: re-apply those purges from the purge register before the copy is used.

Schedule: daily backup at least; the drill monthly. Record each drill's report (`<file>.drill-<time>.json`).

---

## 9. Rollback

### Code

Redeploy the previous commit on DCDeploy (select the earlier build, or push the earlier commit to the branch). Migrations only add, so the older code runs against the newer schema.

```sh
git revert <commit>        # preferred: a new commit that undoes the change
git push sunitha develop
```

Never force-push `develop` or `main`.

### Database

Only if data is damaged, and only from a backup taken before the change:

```sh
node server.js restore-drill FILE --keep   # restores into a new database and checks it
```

Read the report, then point `DATABASE_URL` and `DATABASE_OWNER_URL` at the kept database and restart. Document what was lost between the backup and the restore.

### Checklist

- [ ] Issue written down
- [ ] Backup verified before touching the database
- [ ] Team told
- [ ] Rolled back and `/readyz` green
- [ ] Post-mortem scheduled

---

## 10. Troubleshooting

The server prints one line and exits; the line names the setting.

| Message starts with | Cause | Fix |
|---|---|---|
| `NODE_ENV=production: DATABASE_URL is required` | no database on a production service | set `DATABASE_URL` |
| `NODE_ENV=production: PUBLIC_URL must be the https address` | missing or not `https://host` | set `PUBLIC_URL` exactly |
| `NODE_ENV=production: SMTP_URL is required` / `with tls=off is not accepted` | mail not set, or TLS off | set `SMTP_URL` with `smtps://` or `smtp://` with STARTTLS |
| `NODE_ENV=production: AUTH_USERS ... not accepted` / `ALLOW_PLAINTEXT` / `HSTS=0` | a development setting on a production service | remove it |
| `DATA_KEY must be 32 bytes, base64-encoded` | a bad or missing key | `node server.js gen-key` |
| `/readyz` stays 503 | the database does not answer, or a migration is pending | check the connection string and TLS; run `migrate` from your machine |
| `... was changed after it was applied` | an applied migration file was edited | restore the file; put the change in a new number |
| 503 `busy` on requests | the connection pool is exhausted | known Phase 5 item; check `DATABASE_POOL_MAX` against the host's limit |
| `permission denied` during `migrate` | not connected as `hwp_owner`, or the schema grants of section 4 missing | use the owner string; grant usage and create |

---

## 11. Related

- `README.md`: "Signing in", "The platform operator", "Backups and the restore drill", "Changing the database"
- `.env.example`: every setting with its meaning
- `docs/decisions/0001-structure.md`: the layering and its updates
- `docs/checklists/screen-smoke.md`: reading a screen check
- `ops/README.md`: the operating tools

**Maintained by:** Sunitha Gedikanti
**Review:** at each phase boundary, and before the first real client data
