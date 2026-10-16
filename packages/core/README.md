# packages/core: business rules

The one and only copy of the business rules: UK tax, inheritance tax, the CFA economic balance
sheet, risk profile, data checks, KYC/AML onboarding, reviews, mandate checks and the audit diff.

Moved here unchanged from `public/core.js` in step B2. It is the npm workspace package
`@hwp/core`. Code loads it by relative path (`require('../packages/core/core.js')`), and the
server sends it to the browser as `/core.js`. It is the only copy.

## Rules

- Pure functions only: no network, no storage, no DOM. The browser, the server and the tests
  all load this same file.
- A restructure never edits it. Check with `git diff baseline-before-restructure -- <path to core.js>`.
- A deliberate rule change (for example the April tax-year update) is its own commit with its
  own tests, and the pull request says which figures change and why.
