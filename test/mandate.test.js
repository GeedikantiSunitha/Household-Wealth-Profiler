// Mandate stage: model portfolios, agreed mandate, drift and consistency checks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/core.js');

const check = s => H.bind(s).mandateCheck();
const T = H.today();

test('every household carries the five default models; files saved before models existed get them too', () => {
  assert.equal(H.blank().models.length, 5);
  const old = H.normalise({ household: { name: 'Old file' }, accounts: [] });
  assert.deepEqual(old.models.map(m => m.name), ['Defensive', 'Cautious', 'Balanced', 'Growth', 'Adventurous']);
  for (const m of H.DEFAULT_MODELS) assert.equal(H.ASSET_CLASSES.reduce((t, [k]) => t + m[k], 0), 100, m.name);
  assert.equal(old.mandate.driftTol, 5);
  const kept = H.normalise({ models: [{ name: 'House Balanced', riskMin: 4, riskMax: 4, ukEq: 50, glEq: 50 }] });
  assert.equal(kept.models.length, 1, 'a firm that edited its models keeps its own list');
});

test('the sample household follows the Balanced model and its accounts are overweight equities', () => {
  const M = check(H.sample());
  assert.equal(M.model.name, 'Balanced');
  assert.equal(M.classes.find(c => c.k === 'eq').target, 56);
  assert.ok(M.classes.find(c => c.k === 'eq').current > 61, 'sample portfolio is ~67% equity');
  assert.equal(M.status, 'Drift');
  assert.ok(M.breaches >= 1);
  assert.equal(M.issues.filter(i => i.lvl === 'bad').length, 0);
});

test('an agreed risk outside the model range is a blocker; outside the profile needs a rationale', () => {
  const s = H.sample();
  s.mandate.agreedRisk = 7;
  let M = check(s);
  assert.ok(M.issues.some(i => i.lvl === 'bad' && /outside the Balanced range/.test(i.msg)));
  assert.equal(M.status, 'Incomplete');
  s.mandate.model = 'Adventurous';
  M = check(s);
  assert.equal(M.issues.filter(i => i.lvl === 'bad').length, 0);
  assert.ok(M.issues.some(i => i.lvl === 'warn' && /record the rationale/.test(i.msg)), 'risk 7 vs an average profile');
  s.compliance.riskNote = 'Clients understand and accept the volatility; capacity is high.';
  assert.equal(check(s).issues.some(i => /rationale/.test(i.msg)), false);
});

test('a model that does not add up to 100% is flagged in the mandate check and Data checks', () => {
  const s = H.sample();
  s.models.find(m => m.name === 'Balanced').cash = 20;
  assert.ok(check(s).issues.some(i => i.lvl === 'bad' && /118%/.test(i.msg)));
  assert.ok(H.bind(s).checks().some(c => c.lvl === 'bad' && c.where === 'models'));
});

test('drift uses the mandate tolerance; a portfolio on target is in line', () => {
  const s = H.sample();
  s.accounts = [{ owner: 'P1', wrapper: 'ISA (stocks and shares)', value: 100000, eq: 56, bd: 30, al: 12, cs: 2 }];
  s.mandate.driftTol = 5;
  let M = check(s);
  assert.equal(M.status, 'In line'); assert.equal(M.breaches, 0);
  s.accounts[0].eq = 63; s.accounts[0].bd = 23;
  assert.equal(check(s).breaches, 2);
  s.mandate.driftTol = 10;
  assert.equal(check(s).breaches, 0);
});

test('a missing mandate is a suitability item to review, and the agreement date starts the annual mandate review', () => {
  const s = H.sample();
  s.mandate.model = ''; s.mandate.agreedRisk = '';
  const O = H.bind(s).onboarding();
  assert.ok(O.items.some(i => i.stage === 'suitability' && i.lvl === 'warn' && /Mandate/.test(i.msg)));
  assert.equal(check(s).status, 'Incomplete');
  const R = H.bind(H.sample()).reviews();
  const item = R.items.find(i => i.type === 'Mandate review');
  assert.equal(item.due, H.addYears(H.addDays(T, -9), 1));
});
