// Calculation tests. Expected values are worked out by hand from the
// 2026/27 rules (shown in each comment), not copied from the engine.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../../packages/core/core.js');

// The rules depend on today's date (reviews, expiries, the sample household's own dates). Every test
// runs on the same fixed day, so results never change with the calendar.
test.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T10:00:00Z') });

const VAL = '2026-10-08';
// A household where survival is effectively certain (modal age 200),
// so present values can be checked against simple annuity formulas.
function hh(edit) {
  const s = H.blank();
  s.household.valuationDate = VAL;
  s.household.relationship = 'single';
  s.assumptions.gM = 200; s.assumptions.gF = 200;
  if (edit) edit(s);
  return s;
}
const person = o => Object.assign(H.defaults('members'), { ref: 'P1', role: 'primary', dob: '1971-10-08', sex: 'M', niYears: 35 }, o);
const income = o => Object.assign(H.defaults('income'), { owner: 'P1' }, o);
const account = o => Object.assign(H.defaults('accounts'), { owner: 'P1' }, o);
const near = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= Math.max(tol, Math.abs(expected) * 1e-4), `expected ${expected}, got ${actual}`);

test.describe('income tax (rest of UK, 2026/27)', () => {
  const E = H.bind(hh());
  test('£50,000 salary: (50,000 − 12,570) × 20% = £7,486', () => {
    const r = E.incomeTax(50000, 0, 0, 0); near(r.tax, 7486); assert.equal(r.band, 'Basic');
  });
  test('£100,000: 37,700 × 20% + 49,730 × 40% = £27,432', () => near(E.incomeTax(100000, 0, 0, 0).tax, 27432));
  test('£110,000: allowance tapered to £7,570, tax £33,432', () => {
    const r = E.incomeTax(110000, 0, 0, 0); near(r.pa, 7570); near(r.tax, 33432);
  });
  test('£150,000: no allowance; 7,540 + 34,976 + 11,187 = £53,703', () => {
    const r = E.incomeTax(150000, 0, 0, 0); near(r.pa, 0); near(r.tax, 53703); assert.equal(r.band, 'Additional');
  });
  test('£110,000 with £10,000 gross relief-at-source contribution restores the allowance: £29,432', () => {
    const r = E.incomeTax(110000, 0, 0, 10000); near(r.ani, 100000); near(r.pa, 12570); near(r.tax, 29432);
  });
  test('dividends sit on top: £50k salary + £10k dividends = 7,486 + 9,500 × 35.75% = £10,882.25', () =>
    near(E.incomeTax(50000, 0, 10000, 0).tax, 10882.25));
  test('savings allowance: £30k salary + £2k interest = 3,486 + 1,000 × 20% = £3,686', () =>
    near(E.incomeTax(30000, 2000, 0, 0).tax, 3686));
  test('starting rate for savings: £14k salary + £6k interest = £572', () =>
    near(E.incomeTax(14000, 6000, 0, 0).tax, 572));
});

test.describe('National Insurance', () => {
  const E = H.bind(hh());
  test('employee £50,000: 37,430 × 8% = £2,994.40', () => near(E.niCalc(50000, 0), 2994.4));
  test('employee £60,000: 37,700 × 8% + 9,730 × 2% = £3,210.60', () => near(E.niCalc(60000, 0), 3210.6));
  test('Class 4 on £60,000 profit: 37,700 × 6% + 9,730 × 2% = £2,456.60', () => near(E.niCalc(0, 60000), 2456.6));
});

test.describe('pension allowances', () => {
  test('tapered annual allowance: threshold £210k, adjusted £300k → £40,000', () => {
    const s = hh(s => {
      s.members = [person()];
      s.income = [income({ type: 'Employment salary', amount: 210000 })];
      s.accounts = [account({ wrapper: 'Workplace DC pension', value: 100000, employerContrib: 90000, reliefMethod: 'Net pay' })];
    });
    const t = H.bind(s).memberTax(s.members[0]);
    assert.equal(t.tapered, true); near(t.aa, 40000);
  });
  test('flexible access caps the allowance at the £10,000 MPAA', () => {
    const s = hh(s => { s.members = [person({ flexAccessed: true })]; s.income = [income({ amount: 40000 })]; });
    near(H.bind(s).memberTax(s.members[0]).aa, 10000);
  });
  test('ISA subscriptions across Cash and Stocks & Shares ISAs are added together', () => {
    const s = hh(s => { s.members = [person()]; s.accounts = [account({ wrapper: 'Cash ISA', value: 1, contrib: 5000 }), account({ wrapper: 'Stocks & Shares ISA', value: 1, contrib: 12000 })]; });
    near(H.bind(s).memberTax(s.members[0]).isaUsed, 17000);
  });
});

test.describe('economic balance sheet', () => {
  test('human capital: £50k for 5 years at 4% + 1% premium = 50,000 × 4.329477 = £216,473.83', () => {
    const s = hh(s => {
      s.assumptions.rf = 4; s.assumptions.pLow = 1; s.assumptions.hcAfterTax = false;
      s.members = [person({ occRisk: 'low', retireAge: 60 })];
      s.income = [income({ type: 'Employment salary', amount: 50000, growth: 0 })];
    });
    near(H.bind(s).compute().tot.HH.hc, 216473.83, 1);
  });
  test('spending: £10k a year with inflation equal to the discount rate over 45 years = £450,000', () => {
    const s = hh(s => {
      s.assumptions.rf = 4; s.assumptions.cpi = 4;
      s.members = [person()];
      s.expenses = [Object.assign(H.defaults('expenses'), { label: 'Bills', cat: 'essential', amount: 10000 })];
    });
    const C = H.bind(s).compute(); assert.equal(C.H, 45); near(C.tot.HH.cons, 450000, 1);
  });
  test('goal: £100k in 10 years is inflated at CPI and discounted at gilts', () => {
    const s = hh(s => { s.members = [person()]; s.goals = [Object.assign(H.defaults('goals'), { label: 'X', amount: 100000, inYears: 10 })]; });
    near(H.bind(s).compute().tot.HH.goal, 100000 * Math.pow(1.025 / 1.0425, 10), 1);
  });
  test('full State Pension from 67: 34 years × £241.30 × 52.18 × 80% = £342,476', () => {
    const s = hh(s => { s.assumptions.rf = 4; s.assumptions.spIndex = 4; s.members = [person({ retireAge: 60, retTaxRate: 20 })]; });
    near(H.bind(s).compute().tot.HH.pen, 34 * 241.30 * 52.18 * 0.8, 1);
  });
  test('State Pension with 10 NI years and no more work = 10/35 of the full rate', () => {
    const s = hh(s => { s.members = [person({ niYears: 10, retireAge: 55 })]; });
    const C = H.bind(s).compute(); near(C.derived.P1.spWeekly, 241.30 * 10 / 35);
  });
  test('rent is not turned into human capital (the property value already reflects it)', () => {
    const s = hh(s => { s.members = [person()]; s.income = [income({ type: 'Rental profit', amount: 20000 })]; });
    const T = H.bind(s).compute().tot.HH; near(T.hc, 0); assert.ok(T.pen < 400000); // only the State Pension
  });
  test('defined benefit: £10k from 65, indexation = discount rate, 36 payments × 80% = £288,000', () => {
    const s = hh(s => {
      s.assumptions.rf = 4; s.members = [person({ niYears: 0, retireAge: 55 })];
      s.db = [Object.assign(H.defaults('db'), { owner: 'P1', scheme: 'Scheme', accrued: 10000, nra: 65, indexation: 4 })];
    });
    const line = H.bind(s).compute().lines.find(l => l.label.includes('Scheme'));
    near(line.value, 288000, 1);
  });
  test("defined benefit: spouse's pension adds value for a married couple", () => {
    const s = hh(s => {
      s.assumptions.gM = 87; s.assumptions.gF = 90; s.household.relationship = 'married';
      s.members = [person(), person({ ref: 'P2', role: 'partner', sex: 'F', dob: '1973-01-01' })];
      s.db = [Object.assign(H.defaults('db'), { owner: 'P1', scheme: 'Scheme', accrued: 10000, nra: 65, spousePct: 50 })];
    });
    const C = H.bind(s).compute();
    const sp = C.lines.find(l => l.label.includes("spouse's pension")); const mem = C.lines.find(l => l.label.startsWith('James') || l.label.endsWith(': Scheme'));
    assert.ok(sp && sp.value > 0 && sp.value < mem.value);
  });
  test('deferred CGT: £40k gain at 18% (basic rate) = £7,200; at 24% (higher) = £9,600', () => {
    const mkS = sal => hh(s => { s.members = [person()]; s.income = [income({ amount: sal })]; s.accounts = [account({ wrapper: 'General investment account', value: 100000, baseCost: 60000 })]; });
    near(H.bind(mkS(30000)).compute().tot.HH.tax, 7200);
    near(H.bind(mkS(80000)).compute().tot.HH.tax, 9600);
  });
  test('pension deferred tax respects the lump sum allowance: (2,000,000 − 268,275) × 40% = £692,690', () => {
    const s = hh(s => { s.members = [person({ retTaxRate: 40 })]; s.accounts = [account({ wrapper: 'SIPP', value: 2000000 })]; });
    near(H.bind(s).compute().tot.HH.tax, 692690);
  });
  test('joint items are split equally between the adults', () => {
    const s = hh(s => {
      s.members = [person(), person({ ref: 'P2', role: 'partner' })];
      s.accounts = [account({ owner: 'JOINT', wrapper: 'Current account', value: 100000 })];
    });
    const C = H.bind(s).compute(); near(C.tot.P1.fin, 50000); near(C.tot.P2.fin, 50000); near(C.tot.HH.fin, 100000);
  });
});

test.describe('inheritance tax on second death', () => {
  const home = v => Object.assign(H.defaults('property'), { owner: 'JOINT', type: 'Main residence', value: v });
  const cash = v => account({ owner: 'P1', wrapper: 'Cash savings', value: v });
  const family = (h, c) => hh(s => {
    s.household.relationship = 'married';
    s.members = [person(), person({ ref: 'P2', role: 'partner' }), person({ ref: 'C1', role: 'child', dob: '2015-01-01' })];
    s.property = [home(h)]; s.accounts = [cash(c)];
  });
  test('single, no children: (1,000,000 − 325,000) × 40% = £270,000', () => {
    const s = hh(s => { s.members = [person()]; s.accounts = [cash(1000000)]; });
    near(H.bind(s).compute().kpi.iht, 270000);
  });
  test('married with a child: £1.5m estate − £650k − £350k = £200,000', () =>
    near(H.bind(family(1000000, 500000)).compute().kpi.iht, 200000));
  test('residence band is capped at the home value: 1.5m − 650k − 200k → £260,000', () =>
    near(H.bind(family(200000, 1300000)).compute().kpi.iht, 260000));
  test('residence band tapers above £2m: £2.5m estate keeps £100k → £700,000', () =>
    near(H.bind(family(1000000, 1500000)).compute().kpi.iht, 700000));
  test('life cover not in trust is added to the estate', () => {
    const mkS = inTrust => hh(s => { s.members = [person()]; s.accounts = [cash(500000)]; s.protection = [Object.assign(H.defaults('protection'), { owner: 'P1', type: 'Life cover (level)', sum: 300000, inTrust })]; });
    near(H.bind(mkS(false)).compute().kpi.iht, 190000);
    near(H.bind(mkS(true)).compute().kpi.iht, 70000);
  });
  test('pensions are left out when the April 2027 rule is switched off', () => {
    const s = hh(s => { s.assumptions.pensionIHT = false; s.members = [person()]; s.accounts = [account({ wrapper: 'SIPP', value: 1000000 })]; });
    near(H.bind(s).compute().kpi.iht, 0);
  });
});

test.describe('risk profile and data checks', () => {
  test('selling everything after a fall lowers willingness by two points', () => {
    const s = hh(s => { s.members = [person({ riskTol: '5', lossReaction: 'sellall' })]; });
    const E = H.bind(s); const R = E.riskProfile(E.compute());
    assert.deepEqual(R.will, [3]); assert.equal(R.willingness, 'Below average');
  });
  test('an ISA held jointly is flagged', () => {
    const s = hh(s => { s.members = [person(), person({ ref: 'P2', role: 'partner' })]; s.accounts = [account({ owner: 'JOINT', wrapper: 'Stocks & Shares ISA', value: 1 })]; });
    assert.ok(H.bind(s).checks().some(c => c.lvl === 'bad' && /cannot be held jointly/.test(c.msg)));
  });
  test('Lifetime ISA contributions after 50 are flagged', () => {
    const s = hh(s => { s.members = [person()]; s.accounts = [account({ wrapper: 'Lifetime ISA', value: 1, contrib: 1000 })]; });
    assert.ok(H.bind(s).checks().some(c => /Lifetime ISA/.test(c.msg)));
  });
  test('the sample household computes without errors and has only warnings', () => {
    const s = H.sample(); const E = H.bind(s); const C = E.compute();
    assert.ok(C.tot.HH.A > 0 && C.tot.HH.L > 0);
    assert.deepEqual(E.checks().filter(c => c.lvl === 'bad'), []);
  });
});

test.describe('import helpers', () => {
  const f = k => H.fieldsOf(H.SCHEMA.accounts).find(x => x.k === k);
  test('percent cells formatted as % in Excel are scaled to whole numbers', () => {
    assert.equal(H.coerce(f('fee'), 0.0095, { z: '0.00%' }), 0.95);
    assert.equal(H.coerce(f('fee'), '0.95%'), 0.95);
  });
  test('Yes/No, owners and list labels are understood', () => {
    assert.equal(H.coerce(H.fieldsOf(H.SCHEMA.liabilities).find(x => x.k === 'interestOnly'), 'Yes'), true);
    assert.equal(H.coerce(f('owner'), 'joint'), 'JOINT');
    assert.equal(H.coerce(f('owner'), 'p1'), 'P1');
    const cat = H.fieldsOf(H.SCHEMA.expenses).find(x => x.k === 'cat');
    assert.equal(H.coerce(cat, 'Discretionary'), 'discretionary');
  });
  test('loading JSON keeps only known fields', () => {
    const s = H.normalise(JSON.parse('{"household":{"name":"A","evil":"x","__proto__":{"polluted":1}},"members":[{"ref":"P1","script":"<x>"}]}'));
    assert.equal(s.household.name, 'A'); assert.equal(s.household.evil, undefined);
    assert.equal(s.members[0].script, undefined); assert.equal({}.polluted, undefined);
  });
});
