'use strict';
/**
 * Kraken Spot connector (official REST API, https://api.kraken.com).
 * Market data: public endpoints (no keys). Trading: private endpoints, HMAC-SHA512, API-Key + API-Sign.
 * Create keys with ONLY "Query funds" and "Create & modify orders" — NEVER withdrawal permission.
 * Docs: https://docs.kraken.com/rest/
 */
const crypto = require('crypto');
const { fetchJson, ExchangeApiError } = require('./util');

const BASE = 'https://api.kraken.com';
// Kraken pair names for majors vs USDT / USD.
const PAIR_MAP = { 'BTC/USDT': 'XBTUSDT', 'ETH/USDT': 'ETHUSDT', 'SOL/USDT': 'SOLUSDT', 'XRP/USDT': 'XRPUSDT', 'ADA/USDT': 'ADAUSDT', 'DOGE/USDT': 'DOGEUSDT' };
// Kraken result keys vary (e.g. "ADAUSDT" vs "ADA/USDT"); we match loosely below.

class KrakenConnector {
  constructor() { this.id = 'kraken'; this.name = 'Kraken'; this.kind = 'live'; this.capabilities = { liveTrading: true, analysisOnly: false }; }
  supportedSymbols() { return Object.keys(PAIR_MAP); }

  async getOrderBook(symbol) {
    const pair = PAIR_MAP[symbol];
    if (!pair) throw new ExchangeApiError(this.id, `Kraken: unsupported symbol ${symbol}`);
    const { json, latencyMs } = await fetchJson(`${BASE}/0/public/Depth?pair=${pair}&count=20`, { venue: this.id });
    if (!json || typeof json !== 'object') throw new ExchangeApiError(this.id, 'Kraken: empty or invalid response', { outage: true });
    if (json.error && json.error.length) throw new ExchangeApiError(this.id, 'Kraken: ' + json.error.join(', '));
    const data = firstResult(json.result);
    if (!data) throw new ExchangeApiError(this.id, 'Kraken: empty result for ' + pair, { outage: true });
    return {
      venue: this.id, symbol, source: 'live',
      asks: data.asks.map(([p, q]) => [+p, +q]),
      bids: data.bids.map(([p, q]) => [+p, +q]),
      ts: Date.now(), fetchedAt: Date.now(), sourceTs: data.as && data.as[0], latencyMs,
    };
  }
  async getTicker(symbol) {
    const pair = PAIR_MAP[symbol];
    const { json, latencyMs } = await fetchJson(`${BASE}/0/public/Ticker?pair=${pair}`, { venue: this.id });
    if (!json || typeof json !== 'object') throw new ExchangeApiError(this.id, 'Kraken: empty or invalid response', { outage: true });
    if (json.error && json.error.length) throw new ExchangeApiError(this.id, 'Kraken: ' + json.error.join(', '));
    const t = firstResult(json.result);
    if (!t) throw new ExchangeApiError(this.id, 'Kraken: no ticker data for ' + pair, { outage: true });
    return { venue: this.id, symbol, source: 'live', bid: +t.b[0], ask: +t.a[0], last: +t.c[0], ts: Date.now(), latencyMs };
  }

  async _private(endpoint, params, creds) {
    const path = `/0/private/${endpoint}`;
    const nonce = String(Date.now() * 1000);
    const body = new URLSearchParams({ ...params, nonce }).toString();
    const sha = crypto.createHash('sha256').update(nonce + body).digest();
    const sig = crypto.createHmac('sha512', Buffer.from(creds.apiSecret, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
    const { json } = await fetchJson(`${BASE}${path}`, { venue: this.id, method: 'POST', headers: { 'API-Key': creds.apiKey, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!json || typeof json !== 'object') throw new ExchangeApiError(this.id, 'Kraken: empty or invalid response', { outage: true });
    if (json.error && json.error.length) throw new ExchangeApiError(this.id, 'Kraken: ' + json.error.join(', '));
    return json.result || {};
  }
  async getBalances(creds) {
    const result = await this._private('Balance', {}, creds);
    const balances = {};
    for (const [asset, amt] of Object.entries(result || {})) balances[normalizeKrakenAsset(asset)] = { free: +amt, locked: 0 };
    return balances;
  }
  async placeOrder(creds, { symbol, side, quantity, type = 'market', price }) {
    const pair = PAIR_MAP[symbol];
    const params = { pair, type: side === 'buy' ? 'buy' : 'sell', ordertype: type === 'MARKET' || type === 'market' ? 'market' : 'limit', volume: String(quantity) };
    if (params.ordertype === 'limit') params.price = String(price);
    const result = await this._private('AddOrder', params, creds);
    const txid = (result.txid && result.txid[0]) || null;
    return { venue: this.id, exchangeOrderId: txid, symbol, side, type: params.ordertype, status: 'open', quantity: +quantity, filledQty: 0, avgFillPrice: 0 };
  }
  async cancelOrder(creds, { orderId }) {
    await this._private('CancelOrder', { txid: String(orderId) }, creds);
    return { venue: this.id, exchangeOrderId: String(orderId), status: 'cancelled' };
  }
  async getOpenOrders(creds) {
    const result = await this._private('OpenOrders', {}, creds);
    const out = [];
    for (const [id, o] of Object.entries((result && result.open) || {})) {
      const d = o.descr || {};
      const side = d.type; const pair = d.pair || '';
      out.push({ venue: this.id, exchangeOrderId: id, symbol: fromKrakenPair(pair), side, type: d.ordertype, status: 'open', quantity: +o.vol, filledQty: +(o.vol - (+o.vol_exec ? +o.vol - +o.vol_exec : 0)), avgFillPrice: 0 });
    }
    return out;
  }
  async getOrder(creds, { orderId }) {
    const result = await this._private('QueryOrders', { txid: String(orderId) }, creds);
    const o = result && result[orderId];
    if (!o) throw new ExchangeApiError(this.id, 'Order not found: ' + orderId);
    const filled = +o.vol_exec || 0, qty = +o.vol || 0;
    const fee = o.fee ? +o.fee : 0;
    const status = o.status === 'closed' ? (filled >= qty ? 'filled' : 'partial') : o.status === 'canceled' ? 'cancelled' : 'open';
    const cost = +o.descr_price ? 0 : 0; // average price derived from cost below
    const avg = filled > 0 ? (+o.cost || 0) / filled : 0;
    return { venue: this.id, exchangeOrderId: orderId, symbol: fromKrakenPair(o.pair || (o.descr && o.descr.pair) || ''), side: o.descr && o.descr.type, type: o.descr && o.descr.ordertype, status, quantity: qty, filledQty: filled, avgFillPrice: avg, cost: +o.cost || 0, fee, rawFeeCcy: o.fee_ccy || o.descr && o.descr.ordertype };
  }
}

function firstResult(resultObj) { return resultObj ? resultObj[Object.keys(resultObj)[0]] : null; }
function normalizeKrakenAsset(a) { return a.replace(/^X(?=[A-Z]{3}$)/, '').replace(/^Z(?=[A-Z]{3}$)/, '').replace('XBT', 'BTC'); }
function fromKrakenPair(pair) { return String(pair).replace('XBT', 'BTC').replace(/^([A-Z]{3,4})(USDT|USD|USDC)$/, '$1/$2').replace('XXBT', 'BTC'); }

module.exports = { KrakenConnector };
