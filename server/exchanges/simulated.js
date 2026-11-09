'use strict';
/**
 * Simulated exchange connector — used for development, demos, and tests.
 * It implements the EXACT same interface as the real connectors, so swapping DATA_MODE=live
 * needs no code changes. All numbers it produces are SIMULATED and are labeled as such in the UI.
 *
 * Behavior model:
 *  - Mid price per symbol: mean-reverting random walk around a realistic anchor.
 *  - Per-venue bias (one venue tends rich, another tends cheap) → fleeting arb spreads.
 *  - Random "dislocation events": a venue jumps 0.4–1.1% and mean-reverts over ~8s,
 *    so apparent opportunities appear and DISAPPEAR — mirroring reality.
 *  - Order book: 12 levels/side with jittered depth; quoted spread 1.5–4 bps.
 *  - Outages: random venue outages lasting 4–12s; calls then throw (handled like a real outage).
 *  - Latency: typically 15–90 ms; occasional 400+ ms spike.
 */
const crypto = require('crypto');
const { ExchangeApiError } = require('./util');

const ANCHORS = { 'BTC/USDT': 67400, 'ETH/USDT': 3420, 'SOL/USDT': 163.5, 'XRP/USDT': 0.623, 'ADA/USDT': 0.461, 'DOGE/USDT': 0.159 };
const PER_LEVEL_QTY = { BTC: 0.45, ETH: 5.5, SOL: 85, XRP: 24000, ADA: 30000, DOGE: 60000 };
const VENUE_BIAS = { sim_binance: 1.0000, sim_kraken: 0.9990, sim_coinbase: 1.0008 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SimulatedConnector {
  constructor(id, { seed = null, outageProbPerPoll = 0.02, name = null } = {}) {
    this.id = id;
    this.name = name || id;
    this.kind = 'simulated';
    this.capabilities = { liveTrading: false, analysisOnly: false, paperOnly: true };
    this.bias = VENUE_BIAS[id] ?? 1.0;
    this.rand = seed == null ? Math.random : mulberry32(seed);
    this.outageProbPerPoll = outageProbPerPoll;
    this.state = {}; // symbol -> { mid, dislocation, dislocDecay }
    this.outageUntil = 0;
    this.forceStale = false; // tests flip this to exercise the staleness gate
    for (const [sym, anchor] of Object.entries(ANCHORS)) {
      this.state[sym] = { mid: anchor * this.bias, dislocation: 0, dislocDecay: 1, anchor };
    }
  }

  supportedSymbols() { return Object.keys(ANCHORS); }

  _maybeOutage(now) {
    if (now < this.outageUntil) return true;
    if (this.rand() < this.outageProbPerPoll) {
      this.outageUntil = now + 4000 + this.rand() * 8000;
      return true;
    }
    return false;
  }

  _tick(symbol) {
    const st = this.state[symbol];
    if (!st) throw new ExchangeApiError(this.id, `Symbol ${symbol} not supported by simulator`);
    // Mean-reverting random walk
    const shock = (this.rand() - 0.5) * 0.0035;
    const revert = (st.anchor * this.bias - st.mid) / st.anchor * 0.15;
    st.mid = Math.max(st.mid * (1 + shock + revert), st.anchor * 0.5);
    // Dislocation events — a venue strays from the pack for a few seconds, then mean-reverts
    if (this.rand() < 0.06) {
      st.dislocation = (this.rand() < 0.5 ? -1 : 1) * (0.006 + this.rand() * 0.009);
      st.dislocDecay = 1;
    }
    st.dislocation *= 0.92; // decay toward 0
    return st.mid * (1 + st.dislocation);
  }

  async getOrderBook(symbol) {
    const now = Date.now();
    if (this._maybeOutage(now)) {
      throw new ExchangeApiError(this.id, `${this.id} is currently unavailable (simulated outage) — quotes not trustworthy`, { outage: true });
    }
    const mid = this._tick(symbol);
    const base = symbol.split('/')[0];
    const spreadBps = 1.5 + this.rand() * 2.5;
    const half = mid * (spreadBps / 10000) / 2;
    const mkLevels = (side) => {
      const levels = [];
      let price = side === 'ask' ? mid + half : mid - half;
      const step = mid * 0.0006;
      for (let i = 0; i < 12; i++) {
        const qtyJitter = 0.6 + this.rand() * 0.9;
        const qty = (PER_LEVEL_QTY[base] || 1) * qtyJitter * (1 - i * 0.04);
        levels.push([roundPx(price), roundQty(qty)]);
        price = side === 'ask' ? price + step * (1 + this.rand() * 0.6) : price - step * (1 + this.rand() * 0.6);
      }
      return levels;
    };
    let ts = now;
    if (this.forceStale) ts = now - 90_000; // tests: 90s old quote
    return {
      venue: this.id, symbol, source: 'simulated',
      bids: mkLevels('bid'), asks: mkLevels('ask'),
      ts, fetchedAt: now, latencyMs: Math.round(15 + this.rand() * 75 + (this.rand() < 0.05 ? 400 : 0)),
    };
  }

  async getTicker(symbol) {
    const book = await this.getOrderBook(symbol);
    return { venue: this.id, symbol, source: 'simulated', bid: book.bids[0][0], ask: book.asks[0][0], last: (book.bids[0][0] + book.asks[0][0]) / 2, ts: book.ts, latencyMs: book.latencyMs };
  }

  // The simulator never executes real orders. Paper trading is handled by server/paper.js.
  async placeOrder() { throw new ExchangeApiError(this.id, 'Simulated venues cannot place real orders. Switch to paper mode or configure a real exchange.'); }
  async cancelOrder() { throw new ExchangeApiError(this.id, 'Simulated venues have no live orders to cancel.'); }
  async getOpenOrders() { return []; }
  async getBalances() { throw new ExchangeApiError(this.id, 'Simulated venues expose balances via paper trading only.'); }
}

const roundPx = (p) => (p >= 100 ? Math.round(p * 100) / 100 : p >= 1 ? Math.round(p * 1e4) / 1e4 : Math.round(p * 1e6) / 1e6);
const roundQty = (q) => Math.round(q * 1e6) / 1e6;

module.exports = { SimulatedConnector, ANCHORS };
