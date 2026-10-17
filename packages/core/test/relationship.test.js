// Relationship stage: contact log, actions, complaints and the review diary.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../../packages/core/core.js');

// The rules depend on today's date (reviews, expiries, the sample household's own dates). Every test
// runs on the same fixed day, so results never change with the calendar.
test.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T10:00:00Z') });

const T = H.today();
const d = n => H.addDays(T, n);
function approved(edits = {}) {
  const s = H.sample();
  s.contacts = []; s.actions = []; s.complaints = [];
  Object.assign(s.compliance, { outcome: 'approved', reviewer: 'Chris Reviewer', reviewDate: d(-100) }, edits);
  return s;
}
const diary = s => H.bind(s).reviews();
const find = (R, type) => R.items.filter(i => i.type.startsWith(type));

test('new collections are part of the schema, normalise and the audit diff', () => {
  for (const c of ['contacts', 'actions', 'complaints']) assert.ok(H.COLS.includes(c), c);
  const s = H.normalise({ contacts: [{ date: '2026-01-05', type: 'Call', summary: 'x', evil: 1 }] });
  assert.equal(s.contacts.length, 1); assert.equal(s.contacts[0].evil, undefined); assert.deepEqual(s.actions, []);
  const before = H.blank(); const after = H.normalise({ actions: [{ description: 'Chase ID', status: 'Open' }] });
  assert.ok(H.diff(before, after).some(c => c.field === 'actions[0].description' && c.to === 'Chase ID'));
});

test('annual suitability review falls 12 months after approval, and a review meeting resets it', () => {
  const s = approved();
  let R = diary(s);
  assert.equal(find(R, 'Annual suitability review')[0].due, H.addYears(d(-100), 1));
  assert.equal(find(R, 'KYC and AML refresh')[0].due, H.addYears(d(-100), 3), 'low risk: 3-year KYC cycle');
  s.contacts.push({ date: d(-10), type: 'Review meeting', summary: 'Annual review' });
  R = diary(s);
  assert.equal(find(R, 'Annual suitability review')[0].due, H.addYears(d(-10), 1));
  assert.equal(diary(H.sample()).items.some(i => i.type === 'Annual suitability review'), false, 'not before approval');
});

test('a life event after the last review asks for a reassessment until the next review meeting', () => {
  const s = approved();
  s.contacts.push({ date: d(-30), type: 'Life event', with: 'James', summary: 'Made redundant' });
  let R = diary(s);
  const item = find(R, 'Reassess suitability')[0];
  assert.ok(item); assert.equal(item.status, 'overdue'); assert.equal(item.who, 'James');
  s.contacts.push({ date: d(-5), type: 'Review meeting' });
  assert.equal(find(diary(s), 'Reassess suitability').length, 0);
});

test('open actions with due dates appear; done ones do not; overdue is counted', () => {
  const s = approved();
  s.actions.push({ description: 'Send fee agreement', owner: 'Sam', due: d(-3), status: 'Open' });
  s.actions.push({ description: 'Book review', owner: 'Sam', due: d(20), status: 'Open' });
  s.actions.push({ description: 'Old one', owner: 'Sam', due: d(-40), status: 'Done' });
  const R = diary(s);
  assert.deepEqual(find(R, 'Action:').map(i => [i.type, i.status]), [['Action: Send fee agreement', 'overdue'], ['Action: Book review', 'soon']]);
  assert.ok(R.overdue >= 1);
});

test('a complaint has an 8-week final response deadline until it is answered', () => {
  const s = approved();
  s.complaints.push({ received: d(-50), summary: 'Fees not explained', stage: 'Investigating' });
  let R = diary(s);
  const c = find(R, 'Complaint')[0];
  assert.equal(c.due, d(6)); assert.equal(c.status, 'soon');
  s.complaints[0].stage = 'Final response sent';
  assert.equal(find(diary(s), 'Complaint').length, 0);
});

test('document expiries appear for adults and the diary is sorted soonest first', () => {
  const s = approved();
  s.members[0].idExpiry = d(400); s.members[1].idExpiry = d(10);
  const R = diary(s);
  const ids = find(R, 'Photo ID expires');
  assert.equal(ids.length, 2); assert.equal(ids[0].who.includes('Priya'), true);
  assert.ok(find(R, 'Proof of address refresh').length >= 1);
  const dues = R.items.map(i => i.due);
  assert.deepEqual(dues, [...dues].sort());
  assert.equal(R.nextDue, dues[0]);
});

test('letters of authority: signature, send and chase reminders follow the status', () => {
  const s = approved(); s.loas = [];
  const loa = { provider: 'Aviva', owner: 'P1', policyRef: 'PP1', status: 'With client to sign', createdOn: d(-20), chaseDays: 15 };
  s.loas.push(loa);
  let R = diary(s);
  const sig = find(R, 'Letter of authority: get client signature')[0];
  assert.equal(sig.due, d(-6)); assert.equal(sig.status, 'overdue'); assert.match(sig.detail, /Aviva PP1/);
  Object.assign(loa, { status: 'Signed', signedOn: d(-1) });
  R = diary(s);
  assert.equal(find(R, 'Letter of authority: get client signature').length, 0);
  assert.equal(find(R, 'Letter of authority: send to provider')[0].due, d(-1));
  Object.assign(loa, { status: 'Sent to provider', sentOn: d(-3) });
  assert.equal(find(diary(s), 'Letter of authority: chase provider')[0].due, d(12));
  Object.assign(loa, { status: 'Information received', receivedOn: d(0) });
  assert.equal(find(diary(s), 'Letter of authority').length, 0);
});

test('letters of authority are part of the schema with every request ticked except retirement options', () => {
  const l = H.normalise({ loas: [{ provider: 'Aviva', evil: 1 }] }).loas[0];
  assert.equal(l.evil, undefined); assert.equal(l.status, 'Drafted'); assert.equal(l.chaseDays, 15);
  assert.equal(l.reqValue, true); assert.equal(l.reqGuarantees, true); assert.equal(l.reqRetire, false);
});
