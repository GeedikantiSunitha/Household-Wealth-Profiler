/* What a sign-off vouches for, and when it no longer does (Phase 3). The review sign-off is a
   compliance reviewer's judgement on the onboarding assessment: the AML rating and every KYC,
   document, due diligence and suitability finding. So the server keeps, with the sign-off, a
   fingerprint of that assessment as it was when the sign-off was recorded, and the version of the
   file it was recorded on (record.review). If the assessment is different later (someone corrected
   a client's identity details, switched a risk factor, added a document) the sign-off is STALE: it
   is kept, as evidence of what was reviewed, and shown as out of date until a reviewer records it
   again. Edits that do not change the assessment (a contact note, a task, the address) leave it
   current. The sign-off items themselves are not part of the fingerprint: they are what is being
   decided. The rules engine (packages/core) is not changed or duplicated: the fingerprint is
   worked out from what its onboarding() reports.
     fingerprint(HWP, state)   a hash of that assessment
     isStale(HWP, record)      true when the record has a sign-off recorded on a different assessment
     publicReview(record)      { by, at, version } for the browser (no account id)
     reviewAfter(...)          the record's review after a save: kept, replaced by a new one, or removed */
'use strict';
const crypto = require('crypto');
const { touchesSignOff, signOffBlank } = require('./access.js');

function fingerprint(HWP, state) {
  let facts;
  try {
    const E = HWP.bind(HWP.normalise(state));
    const O = E.onboarding(E.compute());
    facts = { rating: O.rating, items: O.items.filter(i => i.stage !== 'signoff').map(i => [i.stage, i.lvl, i.msg, i.who || '']) };
  } catch (e) { facts = { unreadable: true }; }
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

const hasSignOff = rec => rec && rec.state && rec.state.compliance && !signOffBlank(rec.state.compliance);
const isStale = (HWP, rec) => !!(rec && rec.review && hasSignOff(rec) && fingerprint(HWP, rec.state) !== rec.review.fingerprint);
const publicReview = rec => (rec.review ? { by: rec.review.by, at: rec.review.at, version: rec.review.version } : null);

// The review the record carries after this save. Only an account's own save can record one (not HTTP Basic, which has no account).
function reviewAfter({ HWP, rec, next, diff, ctx, at }) {
  if (!ctx.session || !touchesSignOff(diff)) return rec.review;
  if (!hasSignOff(next)) return null; // withdrawn
  return { by: ctx.name, byId: ctx.userId || null, at, version: next.version, fingerprint: fingerprint(HWP, next.state) };
}

module.exports = { fingerprint, isStale, publicReview, reviewAfter, hasSignOff };
