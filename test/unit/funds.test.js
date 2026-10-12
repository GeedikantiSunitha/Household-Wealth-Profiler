// Fund library: price CSV import and performance figures.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../packages/core/core.js');

// The rules depend on today's date (reviews, expiries, the sample household's own dates). Every test
// runs on the same fixed day, so results never change with the calendar.
test.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T10:00:00Z') });

test('price CSVs from common sources are read to month-end prices', () => {
  const yahoo = 'Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-31,1,1,1,100,90,0\n2024-02-15,1,1,1,105,94,0\n2024-02-29,1,1,1,110,99,0';
  const y = H.parsePriceCSV(yahoo);
  assert.equal(y.column, 'adj close', 'adjusted close is preferred over close');
  assert.deepEqual(y.series, [{ d: '2024-01', p: 90 }, { d: '2024-02', p: 99 }], 'the last price in each month is kept');
  const ft = 'Date,Open,High,Low,Close,Volume\n"Thursday, January 04, 2024",1,1,1,10,1\n"Thursday, February 29, 2024",1,1,1,11,1';
  assert.deepEqual(H.parsePriceCSV(ft).series.map(x => x.d), ['2024-01', '2024-02']);
  assert.deepEqual(H.parsePriceCSV('Date;Price\n31/01/2024;1.50\n29/02/2024;1.65').series, [{ d: '2024-01', p: 1.5 }, { d: '2024-02', p: 1.65 }]);
  assert.deepEqual(H.parsePriceCSV('Date,Price (GBX)\n12 Jan 2024,200\n09 Feb 2024,"2,100"').series.map(x => x.p), [200, 2100]);
  assert.throws(() => H.parsePriceCSV('Name,Weight\nA,1\nB,2'), /date column/);
  assert.throws(() => H.parsePriceCSV('Date,Close\n2024-01-31,10'), /Fewer than two/);
});

test('series survive storage and are summarised, not listed, in the firm audit trail', () => {
  const s = [{ d: '2020-01', p: 1.23456789 }, { d: '2020-02', p: 2 }];
  assert.deepEqual(H.seriesDecode(H.seriesEncode(s)), [{ d: '2020-01', p: 1.2345679 }, { d: '2020-02', p: 2 }]);
  const a = H.firmBlank(), b = H.firmNormalise({ funds: [{ name: 'X', prices: H.seriesEncode(s) }] });
  const ch = H.firmDiff(a, b).find(c => c.field === 'funds[0].prices');
  assert.equal(ch.to, '2 monthly prices 2020-01 to 2020-02');
});

test('returns, annualised returns, discrete years, volatility and drawdown', () => {
  const arr = []; let p = 100;
  for (let i = 0; i <= 72; i++) { arr.push({ d: H.addMonthsYM('2020-09', i), p }); p *= Math.pow(1.1, 1 / 12); }
  const P = H.fundPerf(arr);
  assert.ok(Math.abs(P.cum['1y'] - 0.1) < 1e-9); assert.ok(Math.abs(P.ann['5y'] - 0.1) < 1e-9);
  assert.equal(P.cum['10y'], null, 'not enough history for 10 years');
  assert.equal(P.discrete.length, 5); assert.ok(P.discrete.every(d => Math.abs(d.r - 0.1) < 1e-9));
  assert.equal(P.discrete[0].end, '2026-09'); assert.equal(P.discrete[0].start, '2025-09');
  assert.ok(P.vol < 1e-9); assert.equal(P.maxDD, 0);
  const dd = H.fundPerf([{ d: '2024-01', p: 100 }, { d: '2024-02', p: 120 }, { d: '2024-03', p: 90 }, { d: '2024-04', p: 130 }]);
  assert.ok(Math.abs(dd.maxDD + 0.25) < 1e-9, 'worst fall is from the 120 peak to 90');
});

test('growth of £10,000 uses the common window and starts every line at £10,000', () => {
  const mk = (from, n, g) => Array.from({ length: n }, (_, i) => ({ d: H.addMonthsYM(from, i), p: 100 * Math.pow(1 + g, i) }));
  const G = H.growthCompare([{ name: 'A', series: mk('2015-01', 140, 0.01) }, { name: 'B', series: mk('2019-01', 80, 0.005) }], 0);
  assert.equal(G.start, '2019-01'); assert.equal(G.end, '2025-08');
  assert.ok(G.lines.every(l => Math.abs(l.values[0] - 10000) < 1e-9));
  assert.equal(H.growthCompare([{ name: 'A', series: mk('2015-01', 140, 0.01) }], 36).start, '2023-08');
});
