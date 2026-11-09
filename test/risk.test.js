'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arbscope-risk-'));
process.env.NODE_ENV = 'test';

const { Store } = require('../server/store');
const { validateExecution } = require('../server/risk');
const { STALE_AFTER_MS } = require('../server/config');

const mkBook = (venue, ts) => ({ venue, symbol: 'BTC/USDT', bids: [[67000, 1]], asks: [[67010, 1]], ts, fetchedAt: ts, latencyMs: 20 });
const freshBooks = (ts = Date.now()) => ({ 'BTC/USDT': { venueA: mkBook('venueA', ts), venueB: mkBook('venueB', ts) } });
const goodOpp = { buySymbol: 'BTC/USDT', sellSymbol: 'BTC/USDT', netPnlUSD: 12.5, netReturnPct: 0.6, warnings: [] };
const baseReq = { buyVenue: 'venueA', sellVenue: 'venueB', notionalUSD: 2000, opportunity: goodOpp, live: false };

test('passes with fresh books and positive edge in paper mode', () => {
  const store = new Store(process.env.DATA_DIR);
  const r = validateExecution(store, freshBooks(), baseReq);
  assert.equal(r.ok, true, r.reasons.join('; '));
});

test('kill switch blocks everything', () => {
  const store = new Store(process.env.DATA_DIR);
  store.update(s => { s.killSwitch = true; });
  const r = validateExecution(store, freshBooks(), baseReq);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /kill switch/i.test(x)));
  store.update(s => { s.killSwitch = false; });
});

test('stale order books block execution', () => {
  const store = new Store(process.env.DATA_DIR);
  const r = validateExecution(store, freshBooks(Date.now() - STALE_AFTER_MS - 5000), baseReq);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /Stale data/i.test(x)));
});

test('per-trade notional limit enforced', () => {
  const store = new Store(process.env.DATA_DIR);
  const r = validateExecution(store, freshBooks(), { ...baseReq, notionalUSD: 999999 });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /Per-trade/.test(x)));
});

test('daily loss limit halts trading', () => {
  const store = new Store(process.env.DATA_DIR);
  store.update(s => { s.realizedPnl.push({ ts: new Date().toISOString(), pnl: -300, symbol: 'BTC', venues: 'a->b', note: 'test loss' }); });
  const r = validateExecution(store, freshBooks(), baseReq);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /Daily loss/i.test(x)));
});

test('negative net edge is refused', () => {
  const store = new Store(process.env.DATA_DIR);
  const r = validateExecution(store, freshBooks(), { ...baseReq, opportunity: { ...goodOpp, netPnlUSD: -3.2 } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /Net edge/i.test(x)));
});

test('live mode requires explicit acknowledgement and supported venues', () => {
  const store = new Store(process.env.DATA_DIR);
  // paper mode but live request → blocked
  let r = validateExecution(store, freshBooks(), { ...baseReq, live: true });
  assert.equal(r.ok, false);
  // switch to live + ack but use analysis-only/simulated venues → blocked on venue capability
  store.update(s => { s.mode = 'live'; s.liveTradingAcknowledged = true; });
  r = validateExecution(store, freshBooks(), { ...baseReq, live: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /capability/i.test(x)));
  store.update(s => { s.mode = 'paper'; s.liveTradingAcknowledged = false; });
});

test('missing book blocks execution (venue outage)', () => {
  const store = new Store(process.env.DATA_DIR);
  const books = { 'BTC/USDT': { venueA: mkBook('venueA', Date.now()) } }; // venueB missing
  const r = validateExecution(store, books, baseReq);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /Stale data \(sell\)/.test(x)));
});
