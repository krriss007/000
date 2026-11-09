'use strict';
/**
 * Coinbase connector (public market data via the official Coinbase Exchange API).
 * ANALYSIS ONLY: live order placement is NOT implemented for Coinbase in this build —
 * its current trading API (Advanced Trade) requires CDP API keys with JWT (ES256) auth.
 * The venue participates in detection, depth estimates, and paper trading, and its
 * opportunities are flagged "analysis-only — live execution not supported for this venue".
 * Docs: https://docs.cdp.coinbase.com 
 */
const { fetchJson, ExchangeApiError, toDash } = require('./util');

const BASE = 'https://api.exchange.coinbase.com';
const SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'ETH/USDT', 'BTC/USDT'];

class CoinbaseConnector {
  constructor() { this.id = 'coinbase'; this.name = 'Coinbase'; this.kind = 'live'; this.capabilities = { liveTrading: false, analysisOnly: true }; }
  supportedSymbols() { return SYMBOLS; }

  async getOrderBook(symbol) {
    const product = toDash(symbol);
    const { json, latencyMs } = await fetchJson(`${BASE}/products/${product}/book?level=2`, { venue: this.id });
    if (!json || typeof json !== 'object') throw new ExchangeApiError(this.id, 'Coinbase: empty or invalid response', { outage: true });
    if (json.message) throw new ExchangeApiError(this.id, 'Coinbase: ' + json.message);
    const mk = (l) => (l || []).slice(0, 20).map(([p, q]) => [+p, +q]);
    return { venue: this.id, symbol, source: 'live', bids: mk(json.bids), asks: mk(json.asks), ts: Date.now(), fetchedAt: Date.now(), sourceTs: json.sequence, latencyMs };
  }
  async getTicker(symbol) {
    const product = toDash(symbol);
    const { json, latencyMs } = await fetchJson(`${BASE}/products/${product}/ticker`, { venue: this.id });
    if (!json || typeof json !== 'object') throw new ExchangeApiError(this.id, 'Coinbase: empty or invalid response', { outage: true });
    if (json.message) throw new ExchangeApiError(this.id, 'Coinbase: ' + json.message);
    return { venue: this.id, symbol, source: 'live', bid: +json.bid, ask: +json.ask, last: +json.price, ts: Date.now(), latencyMs };
  }
  async placeOrder() { throw new ExchangeApiError(this.id, 'Coinbase live execution is not enabled in this build (analysis-only venue). Use paper mode or another venue.'); }
  async cancelOrder() { throw new ExchangeApiError(this.id, 'Coinbase live execution is not enabled in this build.'); }
  async getOpenOrders() { return []; }
  async getBalances() { throw new ExchangeApiError(this.id, 'Coinbase authenticated requests are not enabled in this build.'); }
}

module.exports = { CoinbaseConnector };
