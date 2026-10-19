# Household Wealth Profiler

Client onboarding for UK wealth management firms. It captures a household (single
clients, couples with one or two earners, children), runs KYC and AML checks, and
produces a CFA-style economic balance sheet, a tax and allowances view, a risk
profile with an investment policy statement, and an audit trail.

You need Node.js 22 or later (Node 18 and 20 are past end-of-life). The only runtime
package is `pg`, and it is used only when the data is kept in PostgreSQL.

## Quick start (your own machine)

```sh
npm install
npm test          # everything: the rules, the back end, the front end, the repository checks
npm run dev       # http://localhost:8080, sign in as demo / demo, data in ./data-dev
```

The front end and the back end are separate, each with its own `package.json`, tests and start
command (npm workspaces: `frontend`, `backend`, and the rules in `packages/core`):

| Command | Runs |
|---|---|
| `npm run test:frontend` | the front end's tests (`frontend/test`): the API client, the build, the layers, the web tier, the development server |
| `npm run test:backend` | the back end's tests (`backend/test`): the API in both storage modes, services, the database, migrations, single-login mode, backups (the PostgreSQL ones with `TEST_DATABASE_URL`) |
| `npm run test:core` | the business rules (`packages/core/test`) |
| `npm start --workspace backend` | the back end alone: the API on port 3001, no screens |
| `npm start --workspace frontend` | the front end alone on http://localhost:5173, passing `/api/` to `BACKEND_URL` (default http://localhost:3001), with the same headers as its container |
| `npm start` | both in one process, as before |

`test/` at the root keeps what spans both: the repository checks (`test/ci/guards.test.js`) and the
screen check (`npm run screens`, the whole app in a browser).

`npm run dev` turns off encryption and HSTS. Use it only for trying the app locally.

## Deploy (self-hosted, one firm)

### Fly.io (London) — quickest route

Fly.io gives you HTTPS, a UK region and an encrypted volume, and runs the Dockerfile
as it is. Needs a Fly account with a card on file (about $3–5 a month for one small
machine and a 1 GB volume).

```sh
curl -L https://fly.io/install.sh | sh      # install flyctl
fly auth login
scripts/deploy-fly.sh my-firm-profiler adviser1   # app name, then one or more usernames
```

The script asks for each password, creates the encryption key and prints it once
(**save it in a password manager**), stores both as Fly secrets, creates the volume
and deploys. Share `https://<app-name>.fly.dev` and the username and password with each user.
Run exactly one machine; the data is on a single volume. Turn on daily volume
snapshots with `fly volumes update <id> --scheduled-snapshots=true`.

To add or change users later, run the script again with every username. It keeps the existing key.

### DCDeploy

DCDeploy builds each service's Dockerfile from this GitHub repository. Its data centre is in Frankfurt
(EU). Its PostgreSQL (17) gives **one login, which cannot create roles**, and **no TLS**, so the app
runs there in single-login mode (see "Single-login mode" under step 4) and the database is reached over
DCDeploy's private network only. Never switch on the database's public TCP proxy: without TLS,
passwords and data would cross the internet unencrypted.

Four pieces, all in the **same DCDeploy environment** so they share its private network:

| Service | Built from | Public? | Settings (environment variables of that service) |
|---|---|---|---|
| **Database** | DCDeploy's PostgreSQL 17 | No | (DCDeploy's own; note its internal address and its login) |
| **Back end** | `backend/Dockerfile`, port **3001** | No | `DB_LOGIN_MODE=single`, `DATABASE_URL` (the database's internal address and its one login), `DATA_KEY` (`node server.js gen-key`, new per environment), `PUBLIC_URL` (the front end's public https address), `SMTP_URL`, `SMTP_FROM`; optional `OPERATOR_EMAIL`, `TOTP_REQUIRED`, `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `RETENTION_YEARS`, and `CLIENT_IP_HEADER=cf-connecting-ip` once DCDeploy confirms the header. Full list: [backend/.env.example](backend/.env.example) |
| **Front end** | `frontend/Dockerfile`, port 8080 | **Yes**: the domain users open | `BACKEND_URL` = the back end's internal address, `http://<back-end internal hostname>:3001` (its internal link). Nothing else, and never a secret. List: [frontend/.env.example](frontend/.env.example) |
| **Worker** (one-off) | `backend/Dockerfile` | No | The back end's settings. Runs commands on demand: `node server.js migrate`, `node server.js check-db-posture`, the first firm and administrator |

Never set on any service: `AUTH_USERS`, `ALLOW_PLAINTEXT`, `HSTS=0` (the back end refuses to start),
`DATABASE_OWNER_URL`, `DATABASE_OPERATOR_URL` (single login), `BACKUP_*` (the backup job's own).

By default the browser sees one address and the front end passes `/api/` to the back end. For two
addresses, as in the company's other applications (the browser calling the back end directly, with CORS),
set `FRONTEND_ORIGIN` on the back end and `API_BASE_URL` on the front end; it is off unless set, and the
cost (a weaker `SameSite` cookie unless both addresses are subdomains of one domain you own) is written
in [ops/DEPLOYMENT.md](ops/DEPLOYMENT.md), "Or split addresses".

Order for each deploy:

1. Take DCDeploy's database backup when the deploy includes a migration (and, before going live, restore one into a scratch database to prove it).
2. On the worker: `node server.js migrate`, then `node server.js check-db-posture`, which must end "safe for client data". Migrations always run here, inside DCDeploy, never from your machine: the database has no TLS.
3. Deploy the back end; it refuses to start while a migration is pending, so a failed migration stops the deploy and the running version stays up.
4. Deploy the front end. Check `https://<front-end address>/healthz`: `{"ok":true}` means the front end reaches the back end; a front end that stops at start with "host not found in upstream" in its log has a wrong `BACKEND_URL`.
5. First time only, on the worker: `node server.js firm-create "NAME" SEATS`, `node server.js create-user EMAIL "NAME" FIRM_ID admin` and `set-password` (or register on the sign-in page).

### Any other host

### 1. Create users and an encryption key

```sh
node server.js hash-password sam 'a long passphrase'     # one line per user
node server.js hash-password chris 'another passphrase'
node server.js gen-key
```

Put the user lines in `AUTH_USERS`, separated by `;`, and the key in `DATA_KEY`
(see [backend/.env.example](backend/.env.example)). Keep both in your host's secrets store, not in git.
`AUTH_USERS` (HTTP Basic sign-in) is for development and for the file store only: a production
server refuses it and people sign in through the app's own sign-in, which needs PostgreSQL
(see Signing in, under step 4).
**If you lose `DATA_KEY`, the client files cannot be decrypted.** Back it up separately
from the data.

### 2. Run it

With Docker:

```sh
docker build -t wealth-profiler .
docker run -d --name wealth-profiler -p 8080:8080 \
  -v wealth-profiler-data:/data \
  -e AUTH_USERS="$AUTH_USERS" -e DATA_KEY="$DATA_KEY" \
  wealth-profiler
```

Without Docker: `AUTH_USERS=... DATA_KEY=... DATA_DIR=/var/lib/wealth-profiler node server.js`,
kept running with systemd or pm2.

The container needs a persistent volume at `/data`. Any host that runs a Docker
container with a volume works: a UK-region VM, Azure App Service, AWS ECS/Fargate
with EFS, Fly.io, Render.

### 3. Put HTTPS in front

The app **must** be served over HTTPS: the session cookie is Secure (the `__Host-` cookie a
browser only accepts over HTTPS), and the links in sign-in emails point at `PUBLIC_URL`, which in
production must be the `https://` address. The simplest option on a VM is Caddy, which gets
certificates automatically:

```
profiler.yourfirm.co.uk {
    reverse_proxy 127.0.0.1:8080
}
```

### 4. Optional: keep the data in PostgreSQL

By default the server stores files under `DATA_DIR` (development only). Set `DATABASE_URL` and
it uses PostgreSQL 14 or later instead, which production requires. Several firms share one
database: every row carries its `firm_id`, and row-level security policies in the database show
a connection only the firm it has set for its transaction, so one firm's data is unreachable
from another even if application code has a bug. The tables, from [db/migrations](db/migrations):
`firms`, `users`, `memberships`, `households`, `household_versions`, `audit_log`, the firm
settings in `firm_records`, `firm_record_versions` and `firm_audit`, `idempotency_keys` (a day of
create keys, no client data: a hash of firm, user and key, the reply's id and version, and a keyed
hash of the request), the sign-in tables `sessions`, `recovery_codes`, `one_time_tokens`,
`access_requests` and `auth_events` (reachable by the app role only inside sign-in, never client data)
and `schema_migrations`. Database triggers refuse any delete or
rewrite of households, firm settings, versions and audit entries. Each firm's records are
encrypted with the firm's own key, itself stored wrapped by `DATA_KEY`, so the database never
holds readable client data and the master key never touches a record. Saves lock the household's
row, so several server processes can share one database safely.

Two database roles (run once in `psql` as an administrator):

```sql
create user hwp_owner with password 'a long random password';    -- owns the tables, runs migrations
create user hwp_app with password 'another long random password'; -- runs the server: owns nothing, cannot bypass row-level security
create database wealth_profiler owner hwp_owner;
```

A database made before these roles existed belongs to the user that created it; hand its tables
over once, as an administrator: `psql -d wealth_profiler -f db/handover-owner.sql` (ownership only, no data touched).

Then put the settings in `backend/.env` (copy [backend/.env.example](backend/.env.example); a `.env` in the project root still works when there is no `backend/.env`):

```ini
AUTH_USERS=sam:...                 # node server.js hash-password sam 'a long passphrase'
DATA_KEY=...                       # node server.js gen-key
DATABASE_URL=postgres://hwp_app:PASSWORD@localhost:5432/wealth_profiler
DATABASE_OWNER_URL=postgres://hwp_owner:PASSWORD@localhost:5432/wealth_profiler
```

Apply the migrations as the owner, then start the server as the app role:

```sh
node server.js migrate      # any new db/migrations file, as hwp_owner
node server.js migrate-status   # read-only: every migration as applied or PENDING; exit 2 when anything is pending
npm start                   # as hwp_app
```

In development `npm start` applies migrations itself (with `DATABASE_OWNER_URL` when set, else
`DATABASE_URL`). With `NODE_ENV=production` it never does: it refuses to start while a migration
is pending, so a schema change is always a deliberate deploy step. The start-up line shows where the data is kept.
`.env` belongs on the server only, never in `frontend/src/`: everything there is sent to browsers.
Add `?sslmode=require` when the database is on another machine, and URL-encode special
characters in the password.

To move existing households and the firm settings from the file store, with their versions and
audit trail:

```sh
node server.js import-files ./data     # households already in the database are skipped
```

A client reference may exist once per firm: a create or save that would give a household another
household's reference (in any spelling) is refused, and the database's unique index guarantees it.
The index is a keyed hash, filled in for households saved before it existed with
`node server.js index-references`; migration 0005 refuses to apply until any existing duplicates
are resolved, and 0006 refuses until every row names its firm.

Every household and firm settings record is held to field rules before it is stored (text lengths,
numbers, dates, dropdown options, row counts; see backend/src/services/validate.js), and a request
that breaks one is refused with the field path and the rule. Before enforcing the rules on a database
that was filled under older rules, list what would be refused, without changing anything:

```sh
node server.js check-records            # every firm (as the owner on PostgreSQL); exit 2 when anything is flagged
node server.js check-records FIRM_ID    # one firm
```

**Signing in.** With PostgreSQL, people sign in through the app itself: email and password, then a
code from an authenticator app (two-step verification is required for everyone unless the server is
started with `TOTP_REQUIRED=0`, which is for development and early trials only, never with real
client data). A new person registers on the sign-in page, confirms their email address through a
link, and signs in; each registration creates a firm with the registrant as its administrator, who
invites colleagues from the Team page. Nothing is handed to an outside sign-in provider: accounts, sessions and the sign-in
event log live in this database, and the only outside call is the breached-password check, which
sends the first five characters of the password's SHA-1 hash and nothing else.

| | How it works |
|---|---|
| Passwords | 12 to 200 characters, any characters; one that has appeared in a known data breach is refused. Stored as scrypt hashes (OWASP parameters) |
| Two-step verification | Set up at the first sign-in (QR code or key), confirmed with a code; ten single-use recovery codes are shown once. A code is never accepted twice. Signing in with a recovery code makes the person set up a new authenticator, ends their other sessions and emails them |
| Failed sign-ins | Per account: no delay for the first two failures, then 1, 2, 4 ... seconds, up to a minute; at the fifth failure in a row the person is warned by email, once. Per address: 20 attempts in 15 minutes. An unknown email takes as long to refuse as a wrong password |
| Sessions | A cookie, ended after `SESSION_IDLE_MINUTES` without use (30) and in any case after `SESSION_ABSOLUTE_HOURS` (12); a new session id at each step of signing in. Every change is sent with a token bound to the session (CSRF). Changing a password or setting up a new authenticator ends the person's other sessions; Account security has "Sign out everywhere" |
| Forgotten password | A reset link by email, valid 30 minutes and once. The reply is the same whether or not the address has an account |
| Invitations | A link by email, valid 24 hours and once; the person chooses a password and sets up the authenticator |
| Registration | Name, email, firm and password (checked as everywhere); a firm of their own, with the registrant as its administrator; a verification link by email, valid 24 hours and once, before the first sign-in. The reply is the same whether or not the address already has an account (its holder is told by email). At most 3 from one address an hour |

What production needs (the server refuses to start without them, see `backend/.env.example`):

```ini
NODE_ENV=production
PUBLIC_URL=https://profiler.yourfirm.co.uk             # the https address the app is served at
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465    # or smtp://...:587 with STARTTLS; never tls=off
SMTP_FROM=Household Wealth Profiler <no-reply@yourfirm.co.uk>
```

Outside production, without `SMTP_URL`, every email (with its link) is written to the server log
instead, so a developer can follow it. `OPERATOR_EMAIL` is optional and no longer used by the sign-in.

**Lost authenticators** (the operator, from the command line; the decision names who made it,
`--by`, and is recorded in the sign-in event log):

```sh
node server.js reset-mfa dana@example.com --by "Your Name"     # lost both the authenticator and the recovery codes
node server.js list-requests                                   # access requests left from before registration replaced Request Access
```

`reset-mfa` is for someone who has lost both the authenticator app and the recovery codes: check who
they are first, outside the app (for example a call to a number already on file, never one given in
the request). It revokes every recovery code, ends every session, tells them by email, and they set up
a new authenticator at their next sign-in; the password stays. These commands run with the
server's own settings (`DATABASE_URL`, `DATA_KEY`, and `SMTP_URL` to send the emails).

Sign-in accounts are made by the platform operator (below) for a firm's first administrator, and
after that by the firm's own administrators from the **User accounts** screen. The password is read
from standard input so it never appears on a command line, and the account is asked to set up its
authenticator app at its first sign-in:

```sh
node server.js create-user dana@example.com "Dana Adviser" [FIRM_ID] [admin|adviser|compliance]
echo "a passphrase of at least 12 characters" | node server.js set-password dana@example.com
```

**Roles.** A person has one or more roles in a firm (a primary role, and any extra ones, for example an
administrator who is also a compliance reviewer). They can do whatever any of their roles allows, and
the services check this on every call (the table is in `backend/src/services/access.js`; the screens
only mirror it):

| | Administrator | Adviser | Compliance reviewer |
|---|---|---|---|
| Read households and their audit trails | yes | yes | yes |
| Create and change households | yes | yes | no, except the review sign-off |
| Record the review sign-off (outcome and notes) | no | no | yes |
| Read the firm settings | yes | yes | yes |
| Change the firm settings | yes | no | no |
| Read the firm settings audit trail | yes | no | yes |
| User accounts: invite, change roles, deactivate | yes | no | no |

**The review sign-off** is the four-eyes check, and it is built so that it cannot be done by the person
who prepared the file:

- The reviewer and the review date are not typed. When a compliance reviewer chooses the outcome, the
  server puts on their own account (name) and today's date; anything sent for those two fields is
  replaced. Setting the outcome back to pending withdraws the sign-off, and both go.
- Separation of duties is by account, per file. The server keeps, on each file, the accounts that have
  changed it. An account that has changed a file cannot sign it off, whatever roles it holds, and a
  save cannot both change the file and sign it off. Another account with the same name is a different
  person. A file saved before this was kept has no such list; for those, only saves from now on count.
  The named preparer is also still compared by name (the existing four-eyes rule).
- A sign-off belongs to the assessment it was recorded on. The server keeps the version and a
  fingerprint of the onboarding assessment (the AML rating and every KYC, document, due diligence and
  suitability finding). If a later edit changes that assessment, the sign-off is marked out of date: it
  is kept as evidence of what was reviewed, shown as out of date on the Onboarding and compliance and KYC
  screens (and as `reviewStale` on the record), and stays so until a reviewer records it again. Edits
  that do not change the assessment (a contact note, a task, the address) leave it current.
- A firm that wants to sign files off needs a compliance reviewer who has not worked on them. A firm
  of one or two people cannot meet this on its own; how small firms should sign files off is an open
  decision, not settled here.

A change of roles or a deactivation applies at once: the roles are read from the database on every
request, and deactivating someone ends their sessions in that firm in the same step. Each firm always
keeps at least one active administrator who has accepted, a reactivation or invitation needs a free
seat, and nobody can change their own roles or access (another administrator does that). HTTP Basic
sign-in (`AUTH_USERS`, development only) is not restricted by role.

**Inviting someone.** A new email gets an account and an invitation link, and is on the team at once.
An email that already has an account (for example in another firm) is added as a *pending* membership:
it gives no access until that person accepts it. At their next sign-in, after the password and the
authenticator code, they are shown the invitation (firm and roles) and choose to accept or decline;
only then is a firm chosen for them. Declining closes it and frees the seat, and the administrator can
invite them again. The administrator sees "Invitation pending" or "Declined" in User accounts, and the
reply to the invitation is the same either way, so it says nothing about other firms.

**The platform operator** runs the service for several firms: creates firms, sets seats, suspends a
firm, creates accounts, reviews access. The operator uses a database role that cannot read client
records or any account secret, enforced by the database (`db/operator.sql`), and needs no `DATA_KEY`.
An administrator creates the login once, then the owner applies the grants (repeat after a migration
that adds tables):

```sql
create user hwp_operator with password 'a third long random password' nosuperuser nobypassrls nocreatedb nocreaterole;
```

```sh
node server.js grant-operator                    # as the owner (DATABASE_OWNER_URL)
```

```ini
DATABASE_OPERATOR_URL=postgres://hwp_operator:PASSWORD@localhost:5432/wealth_profiler
```

```sh
node server.js firm-create "Alder Wealth" 5      # prints the firm id
node server.js create-user jo@alder.example "Jo Alder" FIRM_ID admin
echo "a passphrase of at least 12 characters" | node server.js set-password jo@alder.example
node server.js firm-list                         # status and seats in use
node server.js firm-seats FIRM_ID 10             # not below the seats in use
node server.js firm-status FIRM_ID suspended     # ends every session in the firm; nothing is deleted
node server.js firm-status FIRM_ID active
node server.js access-review [FIRM_ID]           # who has access: role, authenticator, last sign-in, open sessions
```

These commands (and `create-user` and `set-password`) use `DATABASE_OPERATOR_URL`. In production
they refuse to run without it; in development without it they run as the owner and say so. Every
change is recorded in the sign-in event log. Use `access-review` as the periodic review of who can
reach each firm's records, and keep what you decide.

**Backups and the restore drill.** Run the backup on a schedule (daily at least) as a job of its
own, and the restore drill after every change to the backup set-up and at least monthly. Both
need `pg_dump` / `pg_restore` of at least the server's version (`PG_BIN` if they are not on the PATH):

```sh
node server.js gen-key                  # once: BACKUP_KEY, a key of its own (never DATA_KEY)
node server.js backup                   # BACKUP_DATABASE_URL, BACKUP_DIR, BACKUP_KEY
node server.js restore-drill            # the newest backup in BACKUP_DIR; or name a file
node server.js restore-drill FILE --keep   # keeps the restored copy as a database (a real restore)
```

A backup dumps one consistent snapshot, encrypted as it streams (no unencrypted dump is ever on
disk), with a signed manifest beside it: the row count of every table taken in that same snapshot,
the migrations, triggers and policies, and the file's SHA-256. Backups older than
`BACKUP_RETENTION_DAYS` (35) are removed; the newest never is. Row-level security is forced on every
table, so `BACKUP_DATABASE_URL` must be a superuser or a role with `BYPASSRLS`; the command refuses
`hwp_app` and `hwp_owner` (row security would leave rows out). Copy `BACKUP_DIR` off the hosting
platform, and keep `BACKUP_KEY`, `DATA_KEY` and the backups in three separate places.

The drill checks the manifest's signature and the file's checksum, restores into a new scratch
database (`<database>_restore_drill_<time>`), and checks that every table has its recorded row
count, the migrations, retention triggers and row-security policies are all back, every record
opens with its firm's key (so `DATA_KEY` still works with it), and the app role sees no client row
without a firm and only that firm's with one. It writes a report beside the backup
(`<file>.drill-<time>.json`, with the restore time), drops the scratch database, and exits 0 only
when every check passed. To restore for real: run the drill with `--keep` on the target server,
read the report, then point `DATABASE_URL` / `DATABASE_OWNER_URL` at the kept database (or rename
it) and restart; give `hwp_owner` and `hwp_app` their passwords if the cluster is new. A restore
brings back any household purged after the backup was made: re-apply those purges from the purge
register before the copy is used (see Records and retention).

**Records and retention (Phase 4).** Every read of a client file is logged in the access log (who,
when, which household, the outcome; never client data): the client list, opening a household,
its audit trail, exports from the browser (Excel, JSON, print), subject access exports, and every
refused attempt (an id not in the firm, an action the role may not take). Entries can never be
changed or deleted. An administrator or compliance user records the day a household's
relationship ended (Records and retention, in the firm menu); the household is then kept for
`RETENTION_YEARS` (5, the Money Laundering Regulations 2017 minimum) and may be purged from the day
after: one administrator or compliance user requests the purge with a reason, a different one
approves it, and the database function `purge_household()` deletes the household with every
version, its change audit and its retention row, after checking all of that again. The request
stays as the purge register (who asked, who approved, when, the row counts). Nothing else can
delete a record: the app role has no delete privilege, and the retention triggers refuse every
other delete. Check before approving that no other law, complaint, investigation or litigation
hold requires the record to be kept longer (for example pension transfer advice). Data purged
stays in backups until they age out (`BACKUP_RETENTION_DAYS`).

A client's subject access request is answered from the same page (Subject access export): one
JSON file with the current record, every version, the change audit, the access log and the
retention status, and a cover listing every person in the household, whose data must be
redacted before release unless they agree (UK GDPR Article 15(4)). For a user of the app (an
adviser's own request), the operator runs, as the owner:

```sh
node server.js subject-access-user dana@example.com dana-sar.json
```

which writes the account, memberships, sessions, sign-in events, access requests, access log and
purge decisions, never a password, authenticator, link or code hash.

**Rotating `DATA_KEY`.** Records are sealed with each firm's own key; only those keys are wrapped
by `DATA_KEY`, so rotating it rewrites no record:

```sh
node server.js gen-key                               # the new key; keep it in the secrets store
NEW_DATA_KEY=... node server.js rotate-key           # as the owner: re-wraps every firm key, in one transaction
                                                    # and re-seals every authenticator secret (sign-in accounts)
```

Then set `DATA_KEY` to the new key on every server and restart them; servers still running keep
working from the keys they already unwrapped, so there is no outage. Keep the old key until every
server has restarted, then retire it. The command refuses, changing nothing, while any record is
still sealed with `DATA_KEY` itself (`enc:v1`, from before tenancy); re-sealing those is Phase 4's
work, and such a database keeps its key until then.

**Changing the database.** Add a new file such as `db/migrations/0002_add_x.sql`; never edit
one that has been applied (the server refuses to start if an applied file changes). Each file
runs once, in a transaction with its tracking row, so a failed migration leaves nothing behind
and is retried on the next start. Several servers starting together take turns. Migrations
should only add (tables, columns with defaults, indexes): the retention triggers refuse
deletes anyway. Databases created before migrations were tracked are adopted as they are.
A new migration should name no database role at all (single-login mode, below, refuses a file with
a role reference it has no rule for).

**Single-login mode (`DB_LOGIN_MODE=single`).** For hosts that give one database login and no way to
create roles (DCDeploy). The model is MMW's: the one login owns the tables, runs the migrations and is
the app's connection; it must not be a superuser and must not bypass row-level security (the server
refuses to start otherwise); every table that holds data forces row-level security, so the policies
bind the owner too, and no policy names a role. The migration files are the same; the runner applies
them through `db/single-login.js`, which leaves out role creation and grants, makes every app policy
apply to every role, and puts the owner's policies behind two modes a command switches on for its own
connection: operator mode (`app.operator`: firms and accounts, no client rows) and maintenance mode
(`app.maintenance`: encrypted client rows across firms, for key rotation and checks). The server never
switches either on and refuses a `DATABASE_URL` that does. Commands need no other connection: in this
mode the owner and operator connections are `DATABASE_URL` with the modes on.

What it gives up, as MMW does: the login owns the tables, so it could in principle switch a policy or
trigger off; that rests on the application's code (every query is parameterised). Firm isolation is
unchanged (forced row-level security on a login that cannot bypass it), and so are the retention
triggers and the two-person purge. Backups come from the host (a login that cannot bypass row-level
security cannot read every firm's rows for `node server.js backup`).

```sh
DB_LOGIN_MODE=single node server.js migrate            # no role is created
DB_LOGIN_MODE=single node server.js check-db-posture   # read-only; exit 0 only when every check passes
```

`check-db-posture` (either mode) checks, as the app's own login: not a superuser and no BYPASSRLS
(with separate roles, owning no table either); no operator or maintenance mode on the connection;
every table forcing row-level security with policies, except `schema_migrations`, `firm_settings`
and `firm_versions`, which hold no client or account data; no household visible without a firm; the
retention triggers on every kept table; `purge_household()` as a security definer searching
`pg_temp` last; and no migration pending. Run it before every deploy.

To run the PostgreSQL tests, point them at an empty scratch database:
`TEST_DATABASE_URL=postgres://... node --test backend/test/api/postgres.test.js`.

### 5. The spreadsheet library

Excel import and export use SheetJS 0.20.3, served by the app itself from
`frontend/src/vendor/` and never from a CDN: the Content Security Policy allows scripts from
this server only. The copy is pinned by hash; `npm run vendor` downloads it again from SheetJS
and refuses anything that does not match, and a test checks the committed file. Only the
single-file demo build, opened from disk, fetches it from SheetJS's own CDN.

## What the server does

| Area | How |
|---|---|
| Sign-in | The app's own sign-in with PostgreSQL: email and password (scrypt, breached passwords refused), a required authenticator code, recovery codes, progressive delays per account and a limit per address, sessions with idle and absolute limits, reset and invitation links by email (see Signing in). HTTP Basic (`AUTH_USERS`) is for development only: 10 failed attempts lock the address out for 15 minutes. Behind a proxy, set `CLIENT_IP_HEADER` to the header carrying the real client address (Fly.io: `fly-client-ip`) |
| Storage | One folder per household under `DATA_DIR/households/<id>/`, or PostgreSQL when `DATABASE_URL` is set |
| Encryption at rest | AES-256-GCM on every file or database row, including the audit log |
| Versions | Every save is kept in `versions/` (or `household_versions`). Two people editing at once cannot overwrite each other: the second save is refused and they reload |
| Audit trail | The server compares each save with the previous version and logs who changed which field, when, from what and to what |
| No duplicates | Each create carries an `Idempotency-Key`; a repeat within a day (a double-click, a retried request) returns the first household instead of making a second; the same key with a different request is refused (422). A record that cannot be read is logged and left out of the list rather than hiding every other household |
| Field rules | Every household and firm settings record is held to one rule per field type before it is stored (text lengths, numbers, real dates, dropdown options, row counts; backend/src/services/validate.js). A value outside the rules is refused with 400 `invalid_field` and a list of field paths and rules, never the value. Every error reply carries a `code` (`duplicate_reference`, `version_conflict`, `invalid_field`, `idempotency_mismatch`, `busy`, `not_found`, ...) so the app can show the right message |
| Retention | There is no delete endpoint. The Money Laundering Regulations require records for 5 years after the relationship ends (`RETENTION_YEARS`). After that a household may be purged when one administrator or compliance user requests it and a different one approves; the purge register keeps who, when and what was removed |
| Access log | Every read of a client file, every export and every refused attempt is logged (who, when, which household, outcome), and can never be changed. A subject access export gives a client everything kept about the household |
| Backups | `node server.js backup`: an encrypted (own `BACKUP_KEY`), consistent, checksummed backup with a signed manifest; `node server.js restore-drill` proves it restores, with every record readable and firms kept apart |
| Web security | Content Security Policy, no framing, same-origin check on writes, 2 MB request limit, input is filtered to known fields |
| Operations | `/healthz` (the process is up) and `/readyz` (storage answers) for the host's checks; on SIGTERM requests in flight finish before the process exits. With `NODE_ENV=production` the server refuses to start with files instead of PostgreSQL, without encryption, without HTTPS, or with Basic sign-in |

## Onboarding rules

KYC and onboarding status is worked out from what is recorded:

- **Customer due diligence for each adult:** personal details, NI number format, photo ID (expiry checked), proof of address within 3 months, sanctions and adverse media screening within 3 months, PEP status, source of wealth, CRS/FATCA self-certification and non-UK tax IDs.
- **AML risk rating:** points for PEPs, adverse media, high-risk third countries, non face-to-face meetings, complex structures, cash-intensive wealth, third-party or overseas funds, and large investments. 0–1 points is low (review every 3 years), 2–3 medium (2 years), 4 or more high (yearly). Any PEP or high-risk third country is always high.
- **Enhanced due diligence when high:** EDD findings and verified source of wealth are required. PEP relationships also need named senior management approval.
- **Suitability:** risk attitude, loss reaction, knowledge and experience, capacity for loss, objectives, target market check, and a written rationale when willingness and ability to take risk differ. Recording a vulnerability requires support needs; a health vulnerability also requires explicit consent.
- **Disclosures:** client agreement, fee agreement, ex-ante costs and charges, privacy notice.
- **Four-eyes sign-off:** the reviewer must be a different person from the preparer. An approval with open blockers is shown as "Approved with open issues".

These rules are a starting framework drawn from the Money Laundering Regulations 2017,
JMLSG guidance, FCA COBS and the Consumer Duty. **Your MLRO and compliance team must
review and adapt them to the firm's own risk assessment before use.** Screening
results are entered by hand; the app does not call a sanctions, PEP or electronic ID
provider.

## Relationship management

After onboarding, the **Relationship** section holds the contact log (meetings, calls, review
meetings, life events), agreed actions with owners and due dates, and complaints handled under
DISP. **Reviews due** is worked out from the file for each household, and across the firm from
the client list:

- Annual suitability review: 12 months after approval or the last review meeting (COBS 9A, Consumer Duty).
- KYC and AML refresh on the risk-rating cycle; photo ID expiry; proof of address and screening within 3 months.
- Open actions by due date; a life event recorded after the last review; complaint final responses within 8 weeks.

## Mandate

Each file carries the firm's **model portfolios** (five risk-rated defaults benchmarked to the
ARC Private Client Indices, editable) across eight asset classes: UK, global developed and
emerging equity, gilts and index-linked, corporate bonds, property, alternatives, cash. The
**Mandate** records the model, agreed risk level (1–7), basis (advisory or discretionary),
objective, income need, horizon, restrictions, rebalancing rule and drift tolerance, and when it
was agreed and last reviewed. **Mandate check** compares the agreed risk with the model's range
and the risk profile (a level outside the profile needs a written rationale), and the model's
target with the value-weighted split of the accounts, flagging any class outside the tolerance.
The agreement date starts an annual mandate review in Reviews due.

## Fund performance

Firm settings › **Fund library** lists the firm's funds and benchmarks. Price history is imported
from a CSV download (FT, Trustnet, Morningstar, a provider factsheet, Yahoo): the importer finds
the date and price columns and keeps month-end prices. For exchange-listed funds the self-hosted
server can fetch monthly prices from Alpha Vantage if `ALPHAVANTAGE_KEY` is set (free key, 25
requests a day). **Mandate › Fund performance** shows growth of £10,000, cumulative and annualised
returns, the five discrete 12-month periods, volatility and worst fall, with the past-performance
warning and data source required by COBS 4.6. Use accumulation units or total-return indices so
income is included.

## Calculations

- Income tax and NI use 2026/27 rest-of-UK bands, editable under Assumptions. Check them against HMRC before relying on them. Scottish bands and pension carry forward are not modelled.
- Human capital is the survival-weighted present value of after-tax earnings to retirement, discounted at the gilt rate plus an income-stability premium.
- State Pension, defined benefit pensions (including the spouse's pension), annuities and benefits such as ESA are valued at the gilt rate.
- Spending and goals are inflated and discounted at the gilt rate. Spending is assumed to be paid at the start of each year, which is the prudent choice.
- Deferred tax covers pension withdrawals (with the lump sum allowance), capital gains and investment bond gains.
- IHT on second death includes transferable nil-rate bands, the residence band (capped at the home's net value and tapered above £2m), life cover not written in trust, and pensions from April 2027.

## Project layout

```
packages/core/core.js  schema, tax engine, balance sheet, KYC/AML rules (browser and Node; served as /core.js)
backend/src/       the API, in layers that call downwards only:
  middleware/         the security layer: ten global gates in a fixed order (parse-url, health, api-only,
                      authenticate, sign-in-required, second-step, firm-required, same-site, json-body, csrf),
                      the per-route guards (stage, rate limit, role) and the Basic provider for development
  routes/             tables: which method and path reaches which controller, with that route's guards
  controllers/        one handler per route: read the input, call one service, send the reply
  services/           the decisions: validation, permissions, sign-off, households, firm, members, records;
                      services/auth/ is the app's own sign-in: passwords, sessions, authenticator codes, links, mail
  repositories/       storage: PostgreSQL (row-level security, per-firm keys), the file store, idempotency,
                      the sign-in store (accounts, sessions, the auth event log)
  http/ db/ crypto/ config/ cli/   replies and files, the connection pool, encryption, settings, commands
frontend/src/    the interface: index.html, styles.css, js/ (browser modules, starting at js/main.js), in layers:
  js/pages/           one file per screen, the sign-in screens, and the page switch
  js/components/      form fields, banners, the side rail, the top bar
  js/hooks/           what pages share: the state, the store (autosave, conflicts), look-ups, Excel and downloads
  js/services/api/    the only code that calls the server
  js/lib/ js/content/ js/events/   helpers, text, and the shell that wires typing and buttons
server.js           starts the API (npm start) and runs its commands (hash-password, gen-key, import-files)
db/                 PostgreSQL migrations and the migration runner for the self-hosted API
deploy/             how the app runs: deploy/local/dev.js is npm run dev
ops/                operating a deployment: backups, restores, data migrations (being filled in)
docs/               decision records and the manual screen checklist
scripts/build.js    builds dist/wealth-profiler.html, a single file that runs without a server
test/               unit (rules), api, db, ci and e2e (npm run screens) tests
```

Each of `backend`, `frontend` and `packages/core` has its own README with the detail.

### Adding a field

Add it to `SCHEMA` in `packages/core/core.js`. It then appears in the form, the Excel
template, import, export and the audit trail. Add a rule in `onboarding()` if it
should block onboarding.

### Single-file version

`npm run build` creates `dist/wealth-profiler.html`. It runs from disk with no
server. Data stays in that browser only and there is no sign-in, so it is suitable
for demonstrations, not real client data.
