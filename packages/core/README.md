# packages/core: business rules

The one and only copy of the business rules: UK tax, inheritance tax, the CFA economic balance
sheet, risk profile, data checks, KYC/AML onboarding, reviews, mandate checks and the audit diff.

**Fills in step B2**, when `public/core.js` moves here unchanged. Until then it is empty.

## Rules

- Pure functions only: no network, no storage, no DOM. The browser, the server and the tests
  all load this same file.
- A restructure never edits it. Check with `git diff baseline-before-restructure -- <path to core.js>`.
- A deliberate rule change (for example the April tax-year update) is its own commit with its
  own tests, and the pull request says which figures change and why.
