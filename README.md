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
npm test          # rules (tax, balance sheet, IHT, KYC), the API, migrations, Supabase edition
npm run dev       # http://localhost:8080, sign in as demo / demo, data in ./data-dev
```

`npm run dev` turns off encryption and HSTS. Use it only for trying the app locally.

## Supabase edition (hosted, for selling to multiple firms)

One deployment serves many customer firms. Each firm's records are kept apart, each
person has their own login with two-step verification, and you control each firm's seats
and can suspend a firm.

| Part | Where |
|---|---|
| Database, sign-in, API | Supabase project in London (eu-west-2): `supabase/migrations`, `supabase/functions/api` |
| Web front end | Any static host. The scripts use Cloudflare Pages. `npm run build:web` builds `dist/web` with security headers |

How it differs from the self-hosted server:

- **Sign-in:** Supabase Auth with email and password plus an authenticator-app code (TOTP). Public sign-up is off: you create firms, and firm administrators invite their own staff from the **Team** screen.
- **Data:** Postgres. All reads and writes go through the `api` Edge Function, which uses the same `core.js` rules, versioning and field-level audit trail as `server.js`. Browsers have no direct table access.
- **Retention:** database triggers stop anyone deleting households or changing or deleting versions and audit entries, including the service role.
- **Encryption at rest:** Supabase encrypts its storage (AES-256). There is no separate `DATA_KEY`.

### Deploy

1. Create a Supabase project in **London (eu-west-2)**. Use the Pro plan or above for real client data: Free projects pause and have no backups.
2. In Supabase under Authentication > Emails, set up **custom SMTP** (Postmark, Resend, SES). The built-in sender only emails your own team, so customer invitations would not arrive.
3. Install the Supabase CLI, run `supabase login` and `npx wrangler login`, then:

```sh
export SUPABASE_PROJECT_REF=abcdefghijklmnopqrst
export SUPABASE_PUBLISHABLE_KEY=sb_publishable_...      # never the secret key
export APP_ORIGIN=https://wealth-profiler.pages.dev    # or your own domain
export PAGES_PROJECT=wealth-profiler
scripts/deploy-supabase.sh
```

### The database on other PostgreSQL servers

`supabase db push` (in the deploy script) applies `supabase/migrations`. The same migrations
also run on self-hosted Supabase or on plain PostgreSQL 14+ with:

```sh
DATABASE_URL=postgres://... node scripts/supabase-db.js migrate    # new migrations only
DATABASE_URL=postgres://... node scripts/supabase-db.js backfill   # recompute client-list columns
```

It records migrations in the Supabase CLI's own table, so it and `supabase db push` can be
mixed. On plain PostgreSQL it first creates stand-ins for Supabase's `auth` schema and roles
([supabase/plain-postgres.sql](supabase/plain-postgres.sql)); run that first time as a
superuser. `backfill` fills columns added by later migrations (such as review due dates) for
households saved before them. It changes only those list columns, never saved data, versions
or the audit trail. Sign-in and the API still need Supabase Auth and Edge Functions.

### Running the service

```sh
export SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... APP_ORIGIN=https://...
node scripts/firms.js create "Alder Wealth" jo@alderwealth.co.uk "Jo Alder" 5   # firm, seats, first administrator
node scripts/firms.js list
node scripts/firms.js seats <firm-id> 10
node scripts/firms.js suspend <firm-id>     # e.g. unpaid; data is kept
```

Not built yet: self-service sign-up and card billing (for example Stripe), which would call
the same actions as `firms.js`. Before selling, you will also need a data processing agreement
with each customer, Supabase's DPA, a privacy notice, ICO registration, and usually Cyber
Essentials and a penetration test. Regulated firms will ask for these in their supplier due diligence.

After changing `packages/core/core.js`, run `npm run sync:supabase`. A test fails until you do.

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

DCDeploy builds the Dockerfile from a GitHub repository. Its data centre is in Frankfurt (EU).

1. Connect this repository (private). Leave the build context and Dockerfile path at `./`.
2. Port: `8080`. Run **one instance, always on**; do not enable scale-to-zero or add instances, because the data sits on a single volume.
3. Environment variables: `AUTH_USERS` and `DATA_KEY` (step 1 above), and `CLIENT_IP_HEADER=cf-connecting-ip` if DCDeploy confirms it sets that header on every request (it appears to sit behind Cloudflare). Without it, failed sign-ins from anyone count against the same address.
4. Add a persistent volume mounted at `/data`.
5. Back the volume up on a schedule yourself; DCDeploy's docs do not describe built-in snapshots. Keep the backup and `DATA_KEY` in different places.

### Any other host

### 1. Create users and an encryption key

```sh
node server.js hash-password sam 'a long passphrase'     # one line per user
node server.js hash-password chris 'another passphrase'
node server.js gen-key
```

Put the user lines in `AUTH_USERS`, separated by `;`, and the key in `DATA_KEY`
(see `.env.example`). Keep both in your host's secrets store, not in git.
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

Sign-in uses HTTP Basic authentication, so the app **must** be served over HTTPS.
The simplest option on a VM is Caddy, which gets certificates automatically:

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
create keys, no client data) and `schema_migrations`. Database triggers refuse any delete or
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

Then put the settings in `.env` next to `server.js` (copy [.env.example](.env.example)):

```ini
AUTH_USERS=sam:...                 # node server.js hash-password sam 'a long passphrase'
DATA_KEY=...                       # node server.js gen-key
DATABASE_URL=postgres://hwp_app:PASSWORD@localhost:5432/wealth_profiler
DATABASE_OWNER_URL=postgres://hwp_owner:PASSWORD@localhost:5432/wealth_profiler
```

Apply the migrations as the owner, then start the server as the app role:

```sh
node server.js migrate      # any new db/migrations file, as hwp_owner
npm start                   # as hwp_app
```

In development `npm start` applies migrations itself (with `DATABASE_OWNER_URL` when set, else
`DATABASE_URL`). With `NODE_ENV=production` it never does: it refuses to start while a migration
is pending, so a schema change is always a deliberate deploy step. The start-up line shows where the data is kept.
`.env` belongs on the server only, never in `apps/web/public/`: everything there is sent to browsers.
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

Back up the database (for example `pg_dump` on a schedule, or your provider's backups) and
keep `DATA_KEY` in a different place from the backups. Row-level security is forced on every
table, so a backup must run as a superuser or as a role with `BYPASSRLS`, never as `hwp_app`
(it would see nothing) or `hwp_owner` (it reads but cannot switch row security off).

**Rotating `DATA_KEY`.** Records are sealed with each firm's own key; only those keys are wrapped
by `DATA_KEY`, so rotating it rewrites no record:

```sh
node server.js gen-key                               # the new key; keep it in the secrets store
NEW_DATA_KEY=... node server.js rotate-key           # as the owner: re-wraps every firm key, in one transaction
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

To run the PostgreSQL tests, point them at an empty scratch database:
`TEST_DATABASE_URL=postgres://... node --test test/api/postgres.test.js`.

### 5. The spreadsheet library

Excel import and export use SheetJS 0.20.3, served by the app itself from
`apps/web/public/vendor/` and never from a CDN: the Content Security Policy allows scripts from
this server only. The copy is pinned by hash; `npm run vendor` downloads it again from SheetJS
and refuses anything that does not match, and a test checks the committed file. Only the
single-file demo build, opened from disk, fetches it from SheetJS's own CDN.

## What the server does

| Area | How |
|---|---|
| Sign-in | Named users, passwords hashed with scrypt, 10 failed attempts lock the address out for 15 minutes. Behind a proxy, set `CLIENT_IP_HEADER` to the header carrying the real client address (Fly.io: `fly-client-ip`) |
| Storage | One folder per household under `DATA_DIR/households/<id>/`, or PostgreSQL when `DATABASE_URL` is set |
| Encryption at rest | AES-256-GCM on every file or database row, including the audit log |
| Versions | Every save is kept in `versions/` (or `household_versions`). Two people editing at once cannot overwrite each other: the second save is refused and they reload |
| Audit trail | The server compares each save with the previous version and logs who changed which field, when, from what and to what |
| No duplicates | Each create carries an `Idempotency-Key`; a repeat within a day (a double-click, a retried request) returns the first household instead of making a second. A record that cannot be read is logged and left out of the list rather than hiding every other household |
| Retention | There is no delete endpoint. The Money Laundering Regulations require records for 5 years after the relationship ends. Handle erasure requests through an admin process |
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
income is included. The Supabase edition imports CSVs but does not yet fetch prices.

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
apps/api/src/       the self-hosted API: settings, sign-in, encryption, storage, versions, audit trail, routes
apps/web/public/    the interface: index.html, styles.css, js/ (browser modules, starting at js/main.js)
apps/web/public/cloud.js  sign-in and two-step verification for the Supabase edition
server.js           starts the API (npm start) and runs its commands (hash-password, gen-key, import-files)
db/                 PostgreSQL migrations and the migration runner for the self-hosted API
deploy/             how the app runs: deploy/local/dev.js is npm run dev
ops/                operating a deployment: backups, restores, data migrations (being filled in)
docs/               decision records and the manual screen checklist
supabase/           database migrations and the `api` Edge Function (Supabase edition)
scripts/firms.js    create and manage customer firms (Supabase edition)
scripts/supabase-db.js  apply Supabase migrations to any PostgreSQL 14+, backfill list columns
scripts/build.js    builds dist/wealth-profiler.html, a single file that runs without a server
test/               unit (rules), api, db, supabase and e2e (npm run screens) tests
```

Each of `apps/api`, `apps/web` and `packages/core` has its own README with the detail.

### Adding a field

Add it to `SCHEMA` in `packages/core/core.js`. It then appears in the form, the Excel
template, import, export and the audit trail. Add a rule in `onboarding()` if it
should block onboarding.

### Single-file version

`npm run build` creates `dist/wealth-profiler.html`. It runs from disk with no
server. Data stays in that browser only and there is no sign-in, so it is suitable
for demonstrations, not real client data.
