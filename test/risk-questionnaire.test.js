// Risk questionnaire: fixed scores and bands, results written to the person, consistency checks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/core.js');

const atr = arr => Object.fromEntries(arr.map((v, i) => ['atr' + (i + 1), String(v)]));
const cfl = arr => Object.fromEntries(arr.map((v, i) => ['cfl' + (i + 1), String(v)]));
const ke = arr => Object.fromEntries(arr.map((v, i) => ['ke' + (i + 1), String(v)]));
const full = (a, c, k, loss = 'hold') => ({ owner: 'P1', ...atr(a), loss, ...cfl(c), ...ke(k) });
const nine = total => { const v = Array(9).fill(1); let left = total - 9; for (let i = 0; i < 9 && left > 0; i++) { const add = Math.min(4, left); v[i] += add; left -= add; } return v; };

test('the questionnaire has 9 attitude, 1 loss, 6 capacity and 3 knowledge questions, each with fixed scores', () => {
  assert.equal(H.ATR_Q.length, 9); assert.equal(H.CFL_Q.length, 6); assert.equal(H.KE_Q.length, 3);
  for (const [, , o] of H.ATR_Q) assert.deepEqual(o.map(x => x[0]), ['1', '2', '3', '4', '5']);
  for (const [, , o] of H.CFL_Q) assert.deepEqual(o.map(x => x[0]), ['-1', '0', '1']);
  for (const [, , o] of H.KE_Q) assert.deepEqual(o.map(x => x[0]), ['0', '1', '2', '3']);
  const covered = []; for (const [a, b] of H.ATR_BANDS) for (let t = a; t <= b; t++) covered.push(t);
  assert.deepEqual(covered, Array.from({ length: 37 }, (_, i) => i + 9), 'bands cover 9–45 with no gaps or overlaps');
});

test('every attitude total maps to the documented band, at each boundary', () => {
  const expect = { 9: 1, 13: 1, 14: 2, 18: 2, 19: 3, 23: 3, 24: 4, 29: 4, 30: 5, 34: 5, 35: 6, 39: 6, 40: 7, 45: 7 };
  for (const [t, band] of Object.entries(expect)) {
    const sc = H.rtqScore(full(nine(+t), [0, 0, 0, 0, 0, 0], [1, 1, 1]));
    assert.equal(sc.atr.total, +t); assert.equal(sc.atr.band, band, 'total ' + t);
  }
});

test('capacity for loss and knowledge thresholds', () => {
  const cap = c => H.rtqScore(full(nine(27), c, [1, 1, 1])).cfl.level;
  assert.equal(cap([-1, -1, 0, 0, 0, 0]), 'low'); assert.equal(cap([-1, 0, 0, 0, 0, 0]), 'medium');
  assert.equal(cap([1, 0, 0, 0, 0, 0]), 'medium'); assert.equal(cap([1, 1, 0, 0, 0, 0]), 'high');
  const k = v => H.rtqScore(full(nine(27), [0, 0, 0, 0, 0, 0], v)).ke.level;
  assert.equal(k([0, 1, 0]), 'None'); assert.equal(k([1, 1, 0]), 'Basic'); assert.equal(k([2, 2, 0]), 'Basic');
  assert.equal(k([2, 2, 1]), 'Informed'); assert.equal(k([3, 3, 1]), 'Informed'); assert.equal(k([3, 3, 2]), 'Advanced');
});

test('an incomplete questionnaire gives no result; a complete one gives all four fields', () => {
  const part = full(nine(30), [0, 0, 0, 0, 0, 0], [1, 1, 1]); delete part.cfl6;
  assert.equal(H.rtqScore(part).complete, false); assert.equal(H.rtqResult(part), null);
  assert.equal(H.rtqScore(part).atr.band, 5, 'a finished part still shows its own result');
  assert.deepEqual(H.rtqResult(full(nine(30), [1, 1, 0, 0, 0, 0], [2, 2, 1], 'sellsome')), { riskTol: '5', lossReaction: 'sellsome', capacity: 'high', experience: 'Informed' });
});

test('KYC status flags a missing questionnaire and a record that no longer matches it', () => {
  const s = H.sample();
  let items = H.bind(s).onboarding().items.filter(i => /questionnaire/.test(i.msg));
  assert.equal(items.length, 0, 'the sample is consistent');
  s.members[0].riskTol = '7';
  items = H.bind(s).onboarding().items.filter(i => /questionnaire/.test(i.msg));
  assert.equal(items.length, 1); assert.match(items[0].msg, /differs from the risk questionnaire \(risk tolerance/); assert.equal(items[0].lvl, 'warn');
  s.rtq = s.rtq.filter(q => q.owner !== 'P2');
  items = H.bind(s).onboarding().items.filter(i => /questionnaire not completed/.test(i.msg));
  assert.equal(items.length, 1); assert.match(items[0].msg, /Priya/);
});
