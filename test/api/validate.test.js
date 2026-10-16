// backend/src/services/validate.js: the field rules the API holds a household and the firm
// settings to before storing them. The rules come from the schema in packages/core (never
// changed here): each field type has one rule, and every rule names the field path and the rule,
// never the submitted value. Everything the app itself produces must pass.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../packages/core/core.js');
const { validateHousehold, validateFirm, LIMITS } = require('../../backend/src/services/validate.js');

// A normalised state with one row in each collection, the way the service sees it
const base = () => { const s = H.normalise(H.blank()); for (const c of H.COLS) s[c] = [H.defaults(c)]; return s; };
const errorsFor = (edit) => { const s = base(); edit(s); return validateHousehold(H, s); };
const fields = (edit) => errorsFor(edit).map(e => e.field);
const messages = (edit) => errorsFor(edit).map(e => `${e.field} ${e.message}`);

test('what the app itself produces passes: blank, sample, a normalised round trip, every default row', () => {
  assert.deepEqual(validateHousehold(H, H.normalise(H.blank())), []);
  assert.deepEqual(validateHousehold(H, H.normalise(H.sample())), []);
  assert.deepEqual(validateHousehold(H, H.normalise(JSON.parse(JSON.stringify(H.sample())))), []);
  assert.deepEqual(validateHousehold(H, base()), []);
  assert.deepEqual(validateFirm(H, H.firmNormalise(H.firmBlank())), []);
});

test('what the browser form writes passes: blank numbers, dates and dropdowns, booleans, option values', () => {
  assert.deepEqual(errorsFor(s => { s.accounts[0].value = ''; s.members[0].dob = ''; s.accounts[0].wrapper = ''; s.members[0].smoker = false; s.household.relationship = 'civil'; }), []);
  assert.deepEqual(errorsFor(s => { s.accounts[0].value = 1234.56; s.accounts[0].eq = 60; s.income[0].startAge = 45; s.members[0].dob = '1979-03-14'; }), []);
  assert.deepEqual(errorsFor(s => { s.accounts[0].owner = 'JOINT'; s.income[0].owner = 'P1'; s.actions[0].owner = 'Alex Paraplanner'; s.mandate.model = 'Balanced'; s.loas[0].provider = 'Aviva'; }), []);
});

test('text: accented letters, apostrophes, pound signs and other everyday characters pass', () => {
  assert.deepEqual(errorsFor(s => { s.household.name = "O'Brien & Müller-Łukasz household £"; s.members[0].firstName = 'Zoë'; s.members[0].lastName = "D'Angelo-Nuñez"; s.household.objectives = 'Line one\nLine two: café, naïve, £1,000, 50%, "quotes", <not html>'; }), []);
});

test('text: at most 200 characters, no control characters, no lone surrogates', () => {
  assert.deepEqual(messages(s => { s.household.adviser = 'x'.repeat(201); }), ['household.adviser must be at most 200 characters']);
  assert.deepEqual(errorsFor(s => { s.household.adviser = 'x'.repeat(200); }), []);
  assert.deepEqual(messages(s => { s.household.adviser = 'tab\there'; }), ['household.adviser must not contain control characters']);
  assert.deepEqual(messages(s => { s.household.adviser = 'nul\u0000'; }), ['household.adviser must not contain control characters']);
  assert.deepEqual(messages(s => { s.household.adviser = 'two\nlines'; }), ['household.adviser must not contain control characters']);
  assert.deepEqual(messages(s => { s.household.adviser = 'lone\uD800surrogate'; }), ['household.adviser must not contain control characters']);
  assert.deepEqual(messages(s => { s.household.adviser = 12; }), ['household.adviser must be text']);
  assert.deepEqual(messages(s => { s.household.reference = 'R'.repeat(51); }), ['household.reference must be at most 50 characters']);
});

test('notes (area): at most 5,000 characters, line breaks allowed, other control characters not', () => {
  assert.deepEqual(errorsFor(s => { s.household.objectives = ('line\r\n').repeat(500); }), []);
  assert.deepEqual(messages(s => { s.household.objectives = 'x'.repeat(5001); }), ['household.objectives must be at most 5,000 characters']);
  assert.deepEqual(messages(s => { s.contacts[0].summary = 'bell\u0007'; }), ['contacts[0].summary must not contain control characters']);
});

test('yes/no: true or false; the strings "true" and "false" from older saves are accepted and stored as booleans', () => {
  const s = base(); s.household.willsInPlace = 'true'; s.members[0].smoker = 'false';
  assert.deepEqual(validateHousehold(H, s), []);
  assert.equal(s.household.willsInPlace, true); assert.equal(s.members[0].smoker, false);
  assert.deepEqual(messages(s => { s.household.willsInPlace = 'yes'; }), ['household.willsInPlace must be yes or no']);
  assert.deepEqual(messages(s => { s.household.trusts = 1; }), ['household.trusts must be yes or no']);
});

test('numbers: blank or a finite number within range; a numeric string is stored as a number', () => {
  assert.deepEqual(messages(s => { s.accounts[0].value = 'abc'; }), ['accounts[0].value must be a number']);
  assert.deepEqual(messages(s => { s.accounts[0].value = true; }), ['accounts[0].value must be a number']);
  assert.deepEqual(messages(s => { s.accounts[0].value = 1e13; }), ['accounts[0].value must be between -1,000,000,000,000 and 1,000,000,000,000']);
  assert.deepEqual(errorsFor(s => { s.accounts[0].value = -1e12; }), []);
  const s = base(); s.accounts[0].value = ' 12,500 '; s.accounts[0].baseCost = '£3,000.50';
  assert.deepEqual(validateHousehold(H, s), []);
  assert.equal(s.accounts[0].value, 12500); assert.equal(s.accounts[0].baseCost, 3000.5);
  assert.deepEqual(messages(s => { s.accounts[0].value = '12abc'; }), ['accounts[0].value must be a number']);
});

test('whole numbers and percentages have their own ranges', () => {
  assert.deepEqual(messages(s => { s.income[0].startAge = 45.5; }), ['income[0].startAge must be a whole number']);
  assert.deepEqual(messages(s => { s.income[0].startAge = 1000001; }), ['income[0].startAge must be between -1,000,000 and 1,000,000']);
  assert.deepEqual(messages(s => { s.accounts[0].eq = 1001; }), ['accounts[0].eq must be a number between -1,000 and 1,000']);
  assert.deepEqual(messages(s => { s.accounts[0].eq = 'lots'; }), ['accounts[0].eq must be a number between -1,000 and 1,000']);
  assert.deepEqual(errorsFor(s => { s.accounts[0].eq = -12.5; s.scen.marketFall = 100; s.assumptions.cpi = 2.5; }), []);
});

test('dates: blank or a real calendar date YYYY-MM-DD between 1900 and 2200', () => {
  assert.deepEqual(messages(s => { s.members[0].dob = 'hello'; }), ['members[0].dob must be a date (YYYY-MM-DD)']);
  assert.deepEqual(messages(s => { s.members[0].dob = '14/03/1979'; }), ['members[0].dob must be a date (YYYY-MM-DD)']);
  assert.deepEqual(messages(s => { s.members[0].dob = '2026-02-30'; }), ['members[0].dob must be a date (YYYY-MM-DD)']);
  assert.deepEqual(messages(s => { s.members[0].dob = '1899-12-31'; }), ['members[0].dob must be a date between 1900 and 2200']);
  assert.deepEqual(messages(s => { s.members[0].dob = 20260101; }), ['members[0].dob must be a date (YYYY-MM-DD)']);
  assert.deepEqual(errorsFor(s => { s.members[0].dob = '2024-02-29'; s.household.valuationDate = '2200-12-31'; }), []);
});

test('dropdowns: blank or exactly one of the listed options (strict, also for imported spreadsheets)', () => {
  assert.deepEqual(messages(s => { s.household.region = 'Mars'; }), ['household.region must be one of the listed options']);
  assert.deepEqual(messages(s => { s.accounts[0].wrapper = 'stocks & shares isa'; }), ['accounts[0].wrapper must be one of the listed options']);
  assert.deepEqual(messages(s => { s.actions[0].status = 'Open'; }), ['actions[0].status must be one of the listed options'], 'normalise maps "Open" before validation; a raw "Open" here is refused');
  assert.deepEqual(messages(s => { s.members[0].role = 7; }), ['members[0].role must be one of the listed options']);
  // option values that look like numbers are compared as text and stored as the option value
  const s = base(); s.rtq[0].atr1 = 3;
  assert.deepEqual(validateHousehold(H, s), []); assert.equal(s.rtq[0].atr1, '3');
});

test('owner and person codes: a short code, format only (a code no person carries is a later data-checks warning, not a refusal)', () => {
  assert.deepEqual(errorsFor(s => { s.accounts[0].owner = 'P9'; s.income[0].owner = 'c2'; }), []);
  assert.deepEqual(messages(s => { s.accounts[0].owner = 'P'.repeat(41); }), ['accounts[0].owner must be at most 40 characters']);
  assert.deepEqual(messages(s => { s.db[0].owner = 'P1\u0000'; }), ['db[0].owner must not contain control characters']);
});

test('price series: blank or the monthly price format core.js writes, at most 2,000 points', () => {
  const ok = H.firmNormalise(H.firmBlank()); ok.funds = [H.defaults('funds')];
  ok.funds[0].prices = H.seriesEncode([{ d: '2024-01', p: 100 }, { d: '2024-02', p: 101.5 }]);
  assert.deepEqual(validateFirm(H, ok), []);
  ok.funds[0].prices = 'not a series';
  assert.deepEqual(validateFirm(H, ok).map(e => `${e.field} ${e.message}`), ['funds[0].prices must be a monthly price series of at most 2,000 points']);
  ok.funds[0].prices = Array.from({ length: 2001 }, (_, i) => `${2000 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}:1`).join(';');
  assert.deepEqual(validateFirm(H, ok).map(e => e.field), ['funds[0].prices']);
});

test('structure: each collection is an array of at most 500 rows (people at most 50); unknown fields are already gone', () => {
  assert.deepEqual(messages(s => { s.members = Array.from({ length: 51 }, () => H.defaults('members')); }), ['members must have at most 50 rows']);
  assert.deepEqual(messages(s => { s.contacts = Array.from({ length: 501 }, () => H.defaults('contacts')); }), ['contacts must have at most 500 rows']);
  assert.deepEqual(errorsFor(s => { s.contacts = Array.from({ length: 500 }, () => H.defaults('contacts')); }), []);
  assert.deepEqual(LIMITS, { text: 200, area: 5000, reference: 50, code: 40, rows: 500, members: 50, seriesPoints: 2000, num: 1e12, int: 1e6, pct: 1000 });
});

test('every problem is reported, with the field path and the rule only, never the value', () => {
  const errs = errorsFor(s => { s.members[0].dob = 'SECRET-VALUE'; s.accounts[0].value = 'ALSO-SECRET'; s.household.region = 'NOWHERE'; });
  assert.deepEqual(errs.map(e => e.field), ['household.region', 'members[0].dob', 'accounts[0].value']);
  for (const e of errs) { assert.ok(!/SECRET|NOWHERE/.test(e.message), e.message); assert.ok(!/SECRET|NOWHERE/.test(e.field)); }
});

test('firm settings follow the same rules: details, team, providers and funds', () => {
  const f = H.firmNormalise(H.firmBlank());
  f.firm.name = 'Alder Wealth LLP'; f.team = [{ ...H.defaults('team'), name: 'Alex', role: 'Paraplanner', active: true }];
  assert.deepEqual(validateFirm(H, f), []);
  f.team[0].role = 'Wizard'; f.providers = [{ ...H.defaults('providers'), name: 'x'.repeat(201) }]; f.firm.email = 'a\u0000b';
  assert.deepEqual(validateFirm(H, f).map(e => `${e.field} ${e.message}`), ['firm.email must not contain control characters', 'team[0].role must be one of the listed options', 'providers[0].name must be at most 200 characters']);
  f.team = Array.from({ length: 501 }, () => H.defaults('team')); f.providers = []; f.firm.email = '';
  assert.deepEqual(validateFirm(H, f).map(e => e.field), ['team']);
});
