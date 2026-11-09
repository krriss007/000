'use strict';
/**
 * Atomic JSON-file persistence for application state.
 * Not a database — chosen deliberately for transparency and zero native deps.
 * Writes are atomic (tmp + rename) so a crash mid-write cannot corrupt state.
 * For production at scale, swap this module for Postgres; the call-sites only use get()/update().
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  mode: 'paper', // 'paper' | 'live'  — paper by default, always.
  liveTradingAcknowledged: false,
  // Per-trade notional cap (quote currency) and daily loss limit (quote currency, realized).
  maxTradeNotional: 2000,
  maxDailyLoss: 250,
  maxOpenPositions: 4,
  // Minimum net return (basis points) to surface an opportunity as actionable.
  minNetReturnBps: 15,
  // Assumed funding/carry cost per trade in basis points (spot arb window). 0 by default; shown in assumptions.
  fundingCostBps: 0,
  // Amortized rebalancing cost per round trip (quote currency). Makes transfer costs visible in net P&L.
  amortizedTransferCost: 1.5,
  // Slippage guard: reject book-walk beyond this % from top of book.
  maxSlippagePct: 0.5,
  // Quote equivalence: USDT/USDC/USD treated as par with configurable rates. Shown as an assumption.
  quoteEquivalence: { USD: 1.0, USDT: 1.0, USDC: 1.0 },
  venues: {
    binance: { enabled: true, feeCurrencyNote: 'Fees paid in asset received' },
    kraken: { enabled: true },
    coinbase: { enabled: true },
    sim_binance: { enabled: true },
    sim_kraken: { enabled: true },
    sim_coinbase: { enabled: true },
  },
  watchlist: ['BTC', 'ETH', 'SOL'],
  alertThresholdPct: 0.35,
  notifications: { inApp: true },
  // Optional per-venue fee overrides: { binance: { taker: 0.00075, maker: 0.0005 } }
  feeOverrides: {},
};

const DEFAULT_STATE = () => ({
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  credentials: {},      // venue -> { ciphertext, iv, tag, keyHint, label, addedAt, canTrade } — NEVER plaintext
  paperBalances: {      // starting paper bankroll per venue; base inventory models pre-funded arb desks
    __initial: true,
    sim_binance: { quote: 25000, base: { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 } },
    sim_kraken:  { quote: 25000, base: { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 } },
    sim_coinbase:{ quote: 25000, base: { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 } },
    binance: { quote: 25000, base: { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 } },
    kraken:  { quote: 25000, base: { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 } },
    coinbase:{ quote: 25000, base: { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 } },
  },
  orders: [],           // unified paper/live orders
  realizedPnl: [],      // { ts, pnl, symbol, venues, note }
  auditLog: [],
  killSwitch: false,
  createdAt: new Date().toISOString(),
});

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.data = null;
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(raw);
      // Shallow-merge defaults so new settings appear after upgrades.
      this.data.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), this.data.settings || {});
      if (!this.data.paperBalances) this.data.paperBalances = DEFAULT_STATE().paperBalances;
      if (!Array.isArray(this.data.orders)) this.data.orders = [];
      if (!Array.isArray(this.data.auditLog)) this.data.auditLog = [];
      if (!Array.isArray(this.data.realizedPnl)) this.data.realizedPnl = [];
      if (typeof this.data.killSwitch !== 'boolean') this.data.killSwitch = false;
    } catch (e) {
      this.data = DEFAULT_STATE();
      this.flush();
    }
  }
  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  get() { return this.data; }
  update(fn) { const out = fn(this.data); this.flush(); return out; }
}

module.exports = { Store, DEFAULT_SETTINGS };
