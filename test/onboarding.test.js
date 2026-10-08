// KYC, AML risk rating and sign-off rules.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/core.js');

const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
// A sample household with every onboarding gap closed.
function clean(edit) {
  const s = H.sample();
  const p2 = s.members[1];
  Object.assign(p2, { poaType: 'bank', poaDate: ago(20), sowEvidence: 'verified' });
  Object.assign(s.compliance, { costsDate: ago(5), riskNote: 'Joint portfolio set at balanced; Priya’s ISA held more cautiously.' });
  if (edit) edit(s);
  return s;
}
const run = s => { const E = H.bind(s); return E.onboarding(E.compute()); };
const has = (O, re) => O.items.some(i => i.lvl === 'bad' && re.test(i.msg));

test('the sample household is held at KYC: missing proof of address and costs disclosure', () => {
  const O = run(H.sample());
  assert.equal(O.stage, 'KYC and AML');
  assert.ok(has(O, /Priya: proof of address not obtained/));
  assert.ok(has(O, /Costs and charges disclosure not recorded/));
  assert.equal(O.rating, 'Low');
});

test('a complete, low-risk file is ready for review with no blockers', () => {
  const O = run(clean());
  assert.equal(O.blockerCount, 0, JSON.stringify(O.items.filter(i => i.lvl === 'bad')));
  assert.equal(O.stage, 'Ready for review');
  assert.equal(O.rating, 'Low'); assert.equal(O.reviewYears, 3);
});

test('approval by a different reviewer completes onboarding and sets the next review', () => {
  const O = run(clean(s => Object.assign(s.compliance, { reviewer: 'Chris Compliance', reviewDate: '2026-10-08', outcome: 'approved' })));
  assert.equal(O.stage, 'Approved');
  assert.equal(O.nextReview, '2029-10-08');
});

test('four-eyes: the preparer cannot approve their own file', () => {
  const O = run(clean(s => Object.assign(s.compliance, { reviewer: ' sam adviser ', reviewDate: '2026-10-08', outcome: 'approved' })));
  assert.equal(O.stage, 'Approved with open issues');
  assert.ok(has(O, /different person/));
});

test('a foreign PEP makes the rating high and needs EDD and senior approval', () => {
  const s = clean(s => Object.assign(s.members[0], { pep: 'foreign', pepDetail: 'Former minister, Country X' }));
  s.members[1].sowEvidence = 'obtained';
  const O = run(s);
  assert.equal(O.rating, 'High'); assert.equal(O.edd, true); assert.equal(O.reviewYears, 1);
  assert.ok(has(O, /senior manager approval/));
  assert.ok(has(O, /enhanced due diligence findings/));
  assert.ok(has(O, /Priya: high AML risk needs source of wealth verified/));
  // Resolving them clears the KYC stage
  Object.assign(s.compliance, { eddNotes: 'Wealth from legal practice before office; documents seen.', seniorApprover: 'Head of Compliance', seniorApprovalDate: ago(1) });
  s.members[1].sowEvidence = 'verified';
  assert.equal(run(s).stage, 'Ready for review');
});

test('links to a high-risk third country force enhanced due diligence', () => {
  const O = run(clean(s => { s.compliance.highRiskCountry = true; }));
  assert.equal(O.rating, 'High');
});

test('scores add up: remote meeting + third-party funds = 3 points, medium risk', () => {
  const O = run(clean(s => Object.assign(s.compliance, { meeting: 'remote', fundsRoute: 'Third-party payment' })));
  assert.equal(O.score, 3); assert.equal(O.rating, 'Medium'); assert.equal(O.reviewYears, 2);
});

test('a confirmed sanctions match is prohibited', () => {
  const O = run(clean(s => { s.members[0].sanctions = 'confirmed'; }));
  assert.equal(O.rating, 'Prohibited'); assert.equal(O.stage, 'Prohibited');
});

test('expired ID, stale proof of address and stale screening are blockers', () => {
  const O = run(clean(s => Object.assign(s.members[0], { idExpiry: ago(1), poaDate: ago(120), screenDate: ago(200) })));
  assert.ok(has(O, /James: photo ID has expired/));
  assert.ok(has(O, /James: proof of address is more than 3 months old/));
  assert.ok(has(O, /James: screening is more than 3 months old/));
});

test('NI number format is validated', () => {
  assert.equal(H.validNino('AB 12 34 56 C'), true);
  assert.equal(H.validNino('QQ123456C'), false); // Q is not a valid first letter
  assert.equal(H.validNino('BG123456A'), false); // reserved prefix
  assert.equal(H.validNino('AB123456E'), false); // suffix must be A–D
  const O = run(clean(s => { s.members[0].niNumber = 'AB123'; }));
  assert.ok(has(O, /NI number format is not valid/));
});

test('a health vulnerability needs support needs and explicit consent', () => {
  const O = run(clean(s => { s.members[1].vulnerability = 'Health'; }));
  assert.ok(has(O, /without support needs/));
  assert.ok(has(O, /explicit consent/));
});

test('non-UK tax residence without a tax ID is a blocker', () => {
  const O = run(clean(s => { s.members[0].taxResidencies = 'United Kingdom; France'; }));
  assert.ok(has(O, /without a tax ID/));
});

test('audit diff records field changes and added records', () => {
  const a = H.sample(); const b = JSON.parse(JSON.stringify(a));
  b.members[0].idNumber = '123'; b.goals.push(H.defaults('goals'));
  const d = H.diff(a, b);
  assert.ok(d.some(x => x.field === 'members[0].idNumber' && x.to === '123'));
  assert.ok(d.some(x => x.field === 'goals.count' && x.from === 3 && x.to === 4));
});
