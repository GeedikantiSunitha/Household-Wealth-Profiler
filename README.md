# Household Wealth Profiler

Client onboarding for UK wealth management firms. It captures a household (single
clients, couples with one or two earners, children), runs KYC and AML checks, and
produces a CFA-style economic balance sheet, a tax and allowances view, a risk
profile with an investment policy statement, and an audit trail.

There are no runtime dependencies. You need Node.js 18.17 or later.

## Quick start (your own machine)

```sh
npm test          # 58 tests: tax, balance sheet, IHT, KYC rules, server security
npm run dev       # http://localhost:8080, sign in as demo / demo, data in ./data-dev
```

`npm run dev` turns off encryption and HSTS. Use it only for trying the app locally.

## Deploy

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

### 4. Optional: host the spreadsheet library yourself

Excel import and export use SheetJS. By default the app loads version 0.18.5 from
cdnjs. That version has two published vulnerabilities in file parsing
(CVE-2023-30533, CVE-2024-22363). Run `scripts/fetch-xlsx.sh` before building to
serve the patched 0.20.3 from your own server; the app uses it automatically.

## What the server does

| Area | How |
|---|---|
| Sign-in | Named users, passwords hashed with scrypt, 10 failed attempts lock the address out for 15 minutes |
| Storage | One folder per household under `DATA_DIR/households/<id>/` |
| Encryption at rest | AES-256-GCM on every file, including the audit log |
| Versions | Every save is kept in `versions/`. Two people editing at once cannot overwrite each other: the second save is refused and they reload |
| Audit trail | The server compares each save with the previous version and logs who changed which field, when, from what and to what |
| Retention | There is no delete endpoint. The Money Laundering Regulations require records for 5 years after the relationship ends. Handle erasure requests through an admin process |
| Web security | Content Security Policy, no framing, same-origin check on writes, 2 MB request limit, input is filtered to known fields |

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

## Calculations

- Income tax and NI use 2026/27 rest-of-UK bands, editable under Assumptions. Check them against HMRC before relying on them. Scottish bands and pension carry forward are not modelled.
- Human capital is the survival-weighted present value of after-tax earnings to retirement, discounted at the gilt rate plus an income-stability premium.
- State Pension, defined benefit pensions (including the spouse's pension), annuities and benefits such as ESA are valued at the gilt rate.
- Spending and goals are inflated and discounted at the gilt rate. Spending is assumed to be paid at the start of each year, which is the prudent choice.
- Deferred tax covers pension withdrawals (with the lump sum allowance), capital gains and investment bond gains.
- IHT on second death includes transferable nil-rate bands, the residence band (capped at the home's net value and tapered above £2m), life cover not written in trust, and pensions from April 2027.

## Project layout

```
public/core.js      schema, tax engine, balance sheet, KYC/AML rules (browser and Node)
public/app.js       the interface
public/index.html   page shell
public/styles.css   styles
server.js           API, sign-in, encryption, versions, audit trail
scripts/build.js    builds dist/wealth-profiler.html, a single file that runs without a server
test/               node:test suites
```

### Adding a field

Add it to `SCHEMA` in `public/core.js`. It then appears in the form, the Excel
template, import, export and the audit trail. Add a rule in `onboarding()` if it
should block onboarding.

### Single-file version

`npm run build` creates `dist/wealth-profiler.html`. It runs from disk with no
server. Data stays in that browser only and there is no sign-in, so it is suitable
for demonstrations, not real client data.
