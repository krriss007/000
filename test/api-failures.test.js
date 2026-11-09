'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arbscope-api-'));
process.env.NODE_ENV = 'test';

const { Store } = require('../server/store');
const { MarketDataService } = require('../server/marketData');
const { SimulatedConnector } = require('../server/exchanges/simulated');
const { ExchangeApiError } = require('../server/exchanges/util');

class AlwaysDownConnector extends SimulatedConnector {
  constructor() { super('sim_binance', { seed: 1, outageProbPerPoll: 0 }); }
  async getOrderBook() { throw new ExchangeApiError('sim_binance', 'venue unavailable (test)', { outage: true }); }
}
class RateLimitedConnector extends SimulatedConnector {
  constructor() { super('sim_kraken', { seed: 2, outageProbPerPoll: 0 }); }
  async getOrderBook() { throw new ExchangeApiError('sim_kraken', 'HTTP 429', { status: 429, rateLimited: true }); }
}

test('venue outage is flagged in health and books are excluded/flagged stale, never faked', async () => {
  const store = new Store(process.env.DATA_DIR);
  const md = new MarketDataService({ connectors: [new AlwaysDownConnector(), new SimulatedConnector('sim_kraken', { seed: 3, outageProbPerPoll: 0 })], store });
  await md.pollOnce();
  const snap = md.snapshot();
  const down = snap.health.find(h => h.venue === 'sim_binance');
  const up = snap.health.find(h => h.venue === 'sim_kraken');
  assert.equal(down.reachable, false);
  assert.equal(up.reachable, true);
  assert.ok(/unavailable/i.test(down.lastError));
  // No fabricated book for the down venue
  const books = md.getBooks({ includeStale: true });
  for (const v of Object.values(books)) assert.ok(!v.sim_binance || v.sim_binance.stale !== false);
});

test('rate limit errors are surfaced with rateLimited flag', async () => {
  const store = new Store(process.env.DATA_DIR);
  const md = new MarketDataService({ connectors: [new RateLimitedConnector()], store });
  await md.pollOnce();
  const h = md.snapshot().health.find(x => x.venue === 'sim_kraken');
  assert.equal(h.reachable, false);
  assert.equal(h.rateLimited, true);
});

test('stale simulated quotes are excluded from fresh book set', async () => {
  const store = new Store(process.env.DATA_DIR);
  const c = new SimulatedConnector('sim_binance', { seed: 5, outageProbPerPoll: 0 });
  c.forceStale = true;
  const md = new MarketDataService({ connectors: [c], store });
  await md.pollOnce();
  const fresh = md.getBooks({ includeStale: false });
  assert.equal(Object.keys(fresh).length, 0, 'stale books must not be served as fresh');
  const all = md.getBooks({ includeStale: true });
  const anyStale = Object.values(all).some(v => v.sim_binance && v.sim_binance.stale);
  assert.ok(anyStale, 'expected stale flag on forced-stale books');
});

test('partial outage: remaining venues still produce data', async () => {
  const store = new Store(process.env.DATA_DIR);
  const md = new MarketDataService({ connectors: [new AlwaysDownConnector(), new SimulatedConnector('sim_kraken', { seed: 9, outageProbPerPoll: 0 })], store });
  await md.pollOnce();
  const books = md.getBooks({ includeStale: true });
  assert.ok(Object.values(books).some(v => v.sim_kraken), 'healthy venue data still flows');
});
