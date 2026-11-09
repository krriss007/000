'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { walkBook, slippageCapQty, evaluateOpportunity, evaluateAll } = require('../server/arbitrage');
const { feeSchedule, withdrawalFee, transferDelayMin } = require('../server/fees');

const opts = (over = {}) => ({
  feeFor: (v) => feeSchedule(v === 'venueA' ? 'binance' : 'kraken').taker,
  maxNotional: 2000,
  maxSlippagePct: 0.5,
  fundingCostBps: 0,
  amortizedTransferCost: 1.5,
  quoteRate: (q) => ({ USD: 1, USDT: 1, USDC: 1 })[q] ?? 1,
  baseAsset: 'BTC', quoteA: 'USDT', quoteB: 'USDT',
  venueCapabilities: {}, isSimulated: () => false,
  ...over,
});
const book = (venue, bids, asks, ts = Date.now()) => ({ venue, symbol: 'BTC/USDT', source: 'live', bids, asks, ts, fetchedAt: ts, latencyMs: 30 });
const deepBook = (px) => [
  [px, 2], [px * 1.0005, 2], [px * 1.001, 2], [px * 1.002, 3], [px * 1.004, 3], [px * 1.007, 4], [px * 1.011, 4], [px * 1.016, 5], [px * 1.02, 5], [px * 1.025, 6], [px * 1.03, 6], [px * 1.036, 7],
];

test('walkBook fills across levels with VWAP', () => {
  const r = walkBook(deepBook(100), 3.5, 'buy');
  assert.equal(r.qty, 3.5);
  assert.ok(r.avgPrice > 100 && r.avgPrice < 100.2, `avg ${r.avgPrice}`);
  assert.ok(r.fullyFilled);
  const partial = walkBook([[100, 1]], 2, 'buy');
  assert.equal(partial.qty, 1);
  assert.equal(partial.fullyFilled, false);
});

test('slippageCapQty stops at the guard band', () => {
  const levels = [[100, 1], [100.2, 1], [100.6, 1], [102, 10]];
  const cap = slippageCapQty(levels, 'buy', 0.5); // +0.5% = 100.5 → first two levels only
  assert.equal(cap, 2);
});

test('zero spread loses money after fees (net < 0)', () => {
  const a = book('venueA', [], deepBook(67000));
  const b = book('venueB', deepBook(66950), []);
  const opp = evaluateOpportunity('BTC/USDT', a, b, opts());
  assert.ok(opp.netPnlUSD < 0, 'expected a loss');
  assert.ok(opp.warnings.some(w => /Negative gross spread/.test(w)));
});

test('1% gross spread is profitable after realistic fees, fees are deducted', () => {
  const a = book('venueA', [], deepBook(66000));
  const b = book('venueB', deepBook(66700), []); // +1.06% gross
  const opp = evaluateOpportunity('BTC/USDT', a, b, opts());
  assert.ok(opp.grossSpreadPct > 1.0);
  // gross P&L positive, and fees strictly reduce it
  assert.ok(opp.netPnlUSD < opp.grossPnlUSD);
  assert.ok(Math.abs(opp.totalFeesUSD - (opp.buyFeeUSD + opp.sellFeeUSD)) < 1e-9);
  // binance taker 0.1% of ~2000 + kraken taker 0.26% of ~2020 ≈ 2 + 5.25
  assert.ok(opp.buyFeeUSD > 1.9 && opp.buyFeeUSD < 2.1);
  assert.ok(opp.sellFeeUSD > 4.9 && opp.sellFeeUSD < 5.5);
  assert.ok(opp.netPnlUSD > 0);
  assert.ok(opp.breakEvenMovePct > 0 && opp.breakEvenMovePct < opp.grossSpreadPct + 0.5);
  assert.equal(opp.capitalRequiredUSD, opp.quantity * opp.effBuyPrice + opp.buyFeeUSD + 0);
});

test('amortized transfer cost and funding cost reduce net', () => {
  const a = book('venueA', [], deepBook(66000));
  const b = book('venueB', deepBook(66700), []);
  const base = evaluateOpportunity('BTC/USDT', a, b, opts());
  const withCarry = evaluateOpportunity('BTC/USDT', a, b, opts({ fundingCostBps: 50, amortizedTransferCost: 10 }));
  assert.ok(withCarry.netPnlUSD < base.netPnlUSD);
  assert.ok(withCarry.fundingCostUSD > 0);
  assert.ok(withCarry.amortizedTransferCostUSD === 10);
});

test('depth limits quantity below notional cap and flags it', () => {
  const thin = [[66000, 0.01], [66002, 0.005]]; // only ~1 unit of $... actually 0.015 BTC ≈ $990
  const a = book('venueA', [], thin);
  const b = book('venueB', [[66800, 0.01], [66810, 0.01]], []);
  const opp = evaluateOpportunity('BTC/USDT', a, b, opts({ maxNotional: 100000 }));
  assert.ok(opp.quantity <= 0.015 + 1e-9);
  assert.ok(opp.depthLimited);
  assert.ok(opp.warnings.some(w => /depth/i.test(w)));
});

test('mixed quotes compared under parity and flagged; non-parity rate changes result', () => {
  const a = book('coinbase', [], deepBook(66000).map(([p, q]) => [p, q])); // quote USD
  const b = book('binance', deepBook(66700), []);
  const parity = evaluateOpportunity('BTC/USD', { ...a, symbol: 'BTC/USD' }, b, opts({ quoteA: 'USD', quoteB: 'USDT' }));
  assert.ok(parity.warnings.some(w => /stablecoin-parity/.test(w)));
  // If USD is worth 0.95 USDT, buying USD-priced and selling USDT-priced yields more USD-per-unit edge disappears/appears accordingly
  const skewed = evaluateOpportunity('BTC/USD', { ...a, symbol: 'BTC/USD' }, b, opts({ quoteA: 'USD', quoteB: 'USDT', quoteRate: (q) => ({ USD: 1, USDT: 0.95 })[q] }));
  assert.notEqual(skewed.netReturnPct, parity.netReturnPct);
});

test('evaluateAll groups same base across different symbols (BTC/USD vs BTC/USDT)', () => {
  const booksBySymbol = {
    'BTC/USDT': { binance: book('binance', deepBook(66500), deepBook(66450)) },
    'BTC/USD':  { coinbase: book('coinbase', deepBook(67000), deepBook(66900)) },
  };
  const opps = evaluateAll(booksBySymbol, opts());
  assert.ok(opps.some(o => o.buyVenue === 'binance' && o.sellVenue === 'coinbase'));
});

test('evaluateAll never arbitrages a venue against itself and sorts by net return', () => {
  const booksBySymbol = {
    'ETH/USDT': { venA: book('venA', deepBook(3400), deepBook(3398)), venB: book('venB', deepBook(3410), deepBook(3408)) },
  };
  const opps = evaluateAll(booksBySymbol, opts({ feeFor: () => 0.001 }));
  for (const o of opps) assert.notEqual(o.buyVenue, o.sellVenue);
  for (let i = 1; i < opps.length; i++) assert.ok(opps[i - 1].netReturnPct >= opps[i].netReturnPct);
});

test('fee schedules and transfer metadata are sane', () => {
  assert.equal(feeSchedule('binance').taker, 0.001);
  assert.ok(withdrawalFee('BTC') > 0);
  assert.ok(transferDelayMin('BTC') >= 10); // slow — this is the point of pre-funding
});
