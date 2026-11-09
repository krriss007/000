'use strict';
/**
 * Binance Spot connector (official REST API, https://api.binance.com).
 * Market data: public endpoints, no keys required.
 * Trading: HMAC-SHA256 signed private endpoints — TRADING permission only. No withdrawal calls exist here.
 * Docs: https://binance-docs.github.io/apidocs/spot/en/
 */
const crypto = require('crypto');
const { fetchJson, ExchangeApiError, toFlat } = require('./util');

const BASE = 'https://api.binance.com';
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT'];

class BinanceConnector {
  constructor() { this.id = 'binance'; this.name = 'Binance'; this.kind = 'live'; this.capabilities = { liveTrading: true, analysisOnly: false }; }
  supportedSymbols() { return SYMBOLS; }

  async getOrderBook(symbol) {
    const s = toFlat(symbol);
    const { json, latencyMs } = await fetchJson(`${BASE}/api/v3/depth?symbol=${s}&limit=20`, { venue: this.id });
    if (!json || typeof json !== 'object') throw new ExchangeApiError(this.id, 'Binance: empty or invalid response', { outage: true });
    return normalizeBook(this.id, symbol, json, latencyMs);
  }
  async getTicker(symbol) {
    const s = toFlat(symbol);
    const { json, latencyMs } = await fetchJson(`${BASE}/api/v3/bookTicker?symbol=${s}`, { venue: this.id });
    if (!json || typeof json !== 'object' || json.bidPrice === undefined) throw new ExchangeApiError(this.id, 'Binance: empty or invalid ticker response', { outage: true });
    return { venue: this.id, symbol, source: 'live', bid: +json.bidPrice, ask: +json.askPrice, last: (+json.bidPrice + +json.askPrice) / 2, ts: Date.now(), latencyMs };
  }

  _signedQuery(params, secret) {
    const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' }).toString();
    const sig = crypto.createHmac('sha256', secret).update(q).digest('hex');
    return `${q}&signature=${sig}`;
  }
  async _private(method, path, params, creds) {
    const qs = this._signedQuery(params || {}, creds.apiSecret);
    const url = `${BASE}${path}${method === 'GET' ? '?' + qs : ''}`;
    const headers = { 'X-MBX-APIKEY': creds.apiKey };
    const { json, latencyMs } = await fetchJson(url, { venue: this.id, method, headers, body: method === 'GET' ? undefined : qs });
    return { json, latencyMs };
  }
  async getBalances(creds) {
    const { json } = await this._private('GET', '/api/v3/account', {}, creds);
    const balances = {};
    for (const b of json.balances || []) {
      const free = +b.free, locked = +b.locked;
      if (free > 0 || locked > 0) balances[b.asset] = { free, locked };
    }
    return balances;
  }
  async placeOrder(creds, { symbol, side, quantity, type = 'MARKET', quoteOrderQty, price, timeInForce = 'GTC' }) {
    const params = { symbol: toFlat(symbol), side: side.toUpperCase(), type };
    if (type === 'MARKET' && quoteOrderQty) params.quoteOrderQty = String(quoteOrderQty);
    else params.quantity = String(quantity);
    if (type === 'LIMIT') { params.price = String(price); params.timeInForce = timeInForce; }
    const { json } = await this._private('POST', '/api/v3/order', params, creds);
    return normalizeOrder(this.id, json);
  }
  async cancelOrder(creds, { symbol, orderId }) {
    const { json } = await this._private('DELETE', '/api/v3/order', { symbol: toFlat(symbol), orderId: String(orderId) }, creds);
    return normalizeOrder(this.id, json);
  }
  async getOpenOrders(creds, { symbol } = {}) {
    const params = symbol ? { symbol: toFlat(symbol) } : {};
    const { json } = await this._private('GET', '/api/v3/openOrders', params, creds);
    return (json || []).map(o => normalizeOrder(this.id, o));
  }
  async getOrder(creds, { symbol, orderId }) {
    const { json } = await this._private('GET', '/api/v3/order', { symbol: toFlat(symbol), orderId: String(orderId) }, creds);
    return normalizeOrder(this.id, json);
  }
}

function normalizeBook(venue, symbol, json, latencyMs) {
  const asks = (json.asks || []).map(([p, q]) => [+p, +q]);
  const bids = (json.bids || []).map(([p, q]) => [+p, +q]);
  if (!asks.length || !bids.length) throw new ExchangeApiError(venue, 'Empty order book from Binance', { outage: true });
  return { venue, symbol, source: 'live', bids, asks, ts: Date.now(), fetchedAt: Date.now(), sourceTs: json.lastUpdateId, latencyMs };
}
function normalizeOrder(venue, o) {
  return {
    venue, exchangeOrderId: String(o.orderId), symbol: (o.symbol || '').replace(/(USDT|USD|USDC)$/, '/$1'),
    side: (o.side || '').toLowerCase(), type: (o.type || '').toLowerCase(),
    status: ({ NEW: 'open', PARTIALLY_FILLED: 'partial', FILLED: 'filled', CANCELED: 'cancelled', REJECTED: 'rejected', EXPIRED: 'expired' })[o.status] || String(o.status).toLowerCase(),
    quantity: +(o.origQty || 0), filledQty: +(o.executedQty || 0),
    avgFillPrice: +(o.cummulativeQuoteQty && o.executedQty ? (+o.cummulativeQuoteQty / +o.executedQty) : 0),
    raw: undefined, // never echo the raw payload; nothing secret lives there, but keep logs lean
  };
}

module.exports = { BinanceConnector };
