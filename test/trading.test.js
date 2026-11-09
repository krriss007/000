'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arbscope-flow-'));
process.env.NODE_ENV = 'test';
process.env.DATA_MODE = 'simulated';

const { Store } = require('../server/store');
const { Vault } = require('../server/vault');
const { makeAudit } = require('../server/audit');
const { MarketDataService } = require('../server/marketData');
const { PaperLedger } = require('../server/paper');
const { TradingService } = require('../server/trading');
const { SimulatedConnector } = require('../server/exchanges/simulated');
const crypto = require('crypto');

// Crafted, deterministic books: buy cheap on venueA, sell dear on venueB — positive edge, fresh ts.
const mkBook = (venue, bid, ask, ts = Date.now()) => ({
  venue, symbol: 'BTC/USDT', source: 'live',
  bids: [[bid, 2], [bid * 0.999, 2], [bid * 0.998, 3]],
  asks: [[ask, 2], [ask * 1.001, 2], [ask * 1.002, 3]],
  ts, fetchedAt: ts, latencyMs: 25,
});

function makeCtx() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'arbscope-store-')));
  const audit = makeAudit(store);
  const vault = new Vault(crypto.randomBytes(32).toString('hex'));
  const connectors = [new SimulatedConnector('sim_binance', { seed: 7 }), new SimulatedConnector('sim_kraken', { seed: 8 })];
  const marketData = new MarketDataService({ connectors, store });
  // Inject crafted books directly (no network)
  marketData.books = {
    'BTC/USDT': {
      sim_binance: mkBook('sim_binance', 66500, 66490),
      sim_kraken: mkBook('sim_kraken', 67200, 67190),
    },
  };
  const paper = new PaperLedger(store);
  const trading = new TradingService({ store, vault, audit, marketData, paperLedger: paper, connectors });
  return { store, audit, vault, marketData, paper, trading };
}

test('full paper flow: preview → confirm → balances & orders & realized PnL recorded', async () => {
  const ctx = makeCtx();
  const preview = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC', notionalUSD: 2000 });
  assert.ok(preview.id.startsWith('prv_'));
  assert.equal(preview.legs.length, 2);
  assert.ok(preview.totals.estNetPnlUSD > 0, `expected positive edge, got ${preview.totals.estNetPnlUSD}`);
  assert.equal(preview.mode, 'paper');

  const before = ctx.paper.getBalances();
  const quoteBefore = before.sim_binance.quote, baseBeforeSell = before.sim_kraken.base.BTC;

  const result = await ctx.trading.confirmPreview(preview.id);
  assert.equal(result.status, 'filled');
  assert.equal(result.orders.length, 2);

  const after = ctx.paper.getBalances();
  assert.ok(after.sim_binance.quote < quoteBefore, 'buy venue quote should decrease');
  assert.ok((after.sim_kraken.base.BTC) < baseBeforeSell, 'sell venue base should decrease');
  assert.ok(Math.abs(after.sim_binance.base.BTC - (before.sim_binance.base.BTC + after.sim_kraken.base.BTC - before.sim_kraken.base.BTC)) < 1e-9);

  const s = ctx.store.get();
  assert.ok(s.orders.length >= 2);
  assert.ok(s.realizedPnl.length === 1);
  assert.ok(s.auditLog.some(e => e.action === 'trade.filled'));
});

test('confirm is single-use; expired previews cannot execute', async () => {
  const ctx = makeCtx();
  const p1 = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  await ctx.trading.confirmPreview(p1.id);
  await assert.rejects(() => ctx.trading.confirmPreview(p1.id), /already used/i);

  const p2 = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  ctx.trading.previews.get(p2.id).expiresAtMs = Date.now() - 1000;
  await assert.rejects(() => ctx.trading.confirmPreview(p2.id), /expired/i);
});

test('kill switch blocks confirmation and cancels open orders', async () => {
  const ctx = makeCtx();
  const p = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  await ctx.trading.engageKillSwitch(true, 'test halt');
  assert.equal(ctx.store.get().killSwitch, true);
  await assert.rejects(() => ctx.trading.confirmPreview(p.id), /risk checks/i);
  const summary = await ctx.trading.engageKillSwitch(false);
  assert.equal(summary.engaged, false);
  assert.equal(ctx.store.get().killSwitch, false);
});

test('confirm blocked when market goes stale between preview and confirm', async () => {
  const ctx = makeCtx();
  const p = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  // Books go stale (as if the venue hung)
  for (const v of Object.values(ctx.marketData.books['BTC/USDT'])) v.ts = Date.now() - 60_000;
  await assert.rejects(() => ctx.trading.confirmPreview(p.id), /risk checks/i);
});

test('rejection leaves no orders and no state change', async () => {
  const ctx = makeCtx();
  ctx.store.update(s => { s.realizedPnl.push({ ts: new Date().toISOString(), pnl: -999, symbol: 'BTC', venues: 'x->y', note: 'blow up daily limit' }); });
  const p = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  await assert.rejects(() => ctx.trading.confirmPreview(p.id), /risk checks/i);
  assert.equal(ctx.store.get().orders.length, 0);
});

test('preview embeds risk checks, assumptions, disclaimer and worst-case bounds', () => {
  const ctx = makeCtx();
  const p = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  assert.ok(p.disclaimer.match(/arbitrage can and does lose money/i));
  assert.ok(p.legs[0].worstCasePriceUSD > p.legs[0].estPriceUSD * 0.99);
  assert.ok(Array.isArray(p.riskCheck.checks) && p.riskCheck.checks.length >= 5);
  assert.ok(p.opportunity.assumptions.length > 2);
  assert.ok(p.opportunity.breakEvenMovePct !== undefined);
});

test('audit trail records preview and confirm decisions', async () => {
  const ctx = makeCtx();
  const p = ctx.trading.createPreview({ buyVenue: 'sim_binance', sellVenue: 'sim_kraken', baseAsset: 'BTC' });
  await ctx.trading.confirmPreview(p.id);
  const actions = ctx.store.get().auditLog.map(e => e.action);
  assert.ok(actions.includes('trade.preview'));
  assert.ok(actions.includes('trade.filled'));
});
