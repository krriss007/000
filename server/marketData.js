'use strict';
/**
 * Market data service: polls every enabled connector for watchlist symbols,
 * tracks per-venue health/latency/rate-limit status, detects stale books,
 * and keeps a short price history for charts. Never fabricates data:
 * on failure the venue is flagged and its books are EXCLUDED from trading decisions.
 */
const { STALE_AFTER_MS, POLL_INTERVAL_MS } = require('./config');

const WATCH_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'BTC/USD', 'ETH/USD', 'SOL/USD'];

class MarketDataService {
  constructor({ connectors, store, staleAfterMs = STALE_AFTER_MS, pollIntervalMs = POLL_INTERVAL_MS, now = () => Date.now(), shouldPoll = null }) {
    this.connectors = connectors;
    this.store = store;
    this.staleAfterMs = staleAfterMs;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.shouldPoll = shouldPoll || (() => true);
    this.books = {};   // symbol -> venue -> book
    this.health = {};  // venue -> { venue, name, kind, lastSuccessTs, lastError, consecutiveErrors, rateLimited, latencyMs, reachable }
    this.history = {}; // `${venue}:${symbol}` -> [{ t, bid, ask, mid }] (ring, max 400)
    this.timer = null;
    this.listeners = new Set();
    for (const c of connectors) {
      this.health[c.id] = {
        venue: c.id, name: c.name || c.id, kind: c.kind || 'live',
        reachable: null, lastSuccessTs: null, lastError: null, consecutiveErrors: 0, rateLimited: false, latencyMs: null,
        polling: this.shouldPoll(c),
      };
    }
  }

  supportedSymbolsFor(connector) { return connector.supportedSymbols ? connector.supportedSymbols() : WATCH_SYMBOLS; }

  async pollOnce() {
    const settings = this.store.get().settings;
    const jobs = [];
    for (const connector of this.connectors) {
      if (!this.shouldPoll(connector)) continue; // not polled in this DATA_MODE — health card says so
      const vcfg = settings.venues[connector.id];
      if (vcfg && vcfg.enabled === false) continue;
      for (const symbol of this.supportedSymbolsFor(connector)) {
        jobs.push(this._pollOne(connector, symbol));
      }
    }
    await Promise.allSettled(jobs);
    this._emit('update');
    return this.snapshot();
  }

  async _pollOne(connector, symbol) {
    const h = this.health[connector.id];
    try {
      const book = await connector.getOrderBook(symbol);
      const nowTs = this.now();
      book.fetchedAt = book.fetchedAt || nowTs;
      book.stale = (nowTs - (book.ts || 0)) > this.staleAfterMs;
      this.books[symbol] = this.books[symbol] || {};
      this.books[symbol][connector.id] = book;
      h.reachable = true; h.lastSuccessTs = nowTs; h.lastError = null; h.consecutiveErrors = 0; h.rateLimited = false; h.latencyMs = book.latencyMs;
      const key = `${connector.id}:${symbol}`;
      const mid = book.bids.length && book.asks.length ? (book.bids[0][0] + book.asks[0][0]) / 2 : null;
      if (mid != null) {
        const arr = (this.history[key] = this.history[key] || []);
        arr.push({ t: nowTs, bid: book.bids[0][0], ask: book.asks[0][0], mid });
        if (arr.length > 400) arr.splice(0, arr.length - 400);
      }
    } catch (e) {
      h.reachable = false;
      h.lastError = e.message || String(e);
      h.consecutiveErrors += 1;
      h.rateLimited = !!e.rateLimited;
      // Drop the stale book from trading consideration once the venue errors and data ages out.
      if (this.books[symbol] && this.books[symbol][connector.id]) {
        const b = this.books[symbol][connector.id];
        if (this.now() - (b.ts || 0) > this.staleAfterMs) delete this.books[symbol][connector.id];
        else b.stale = true; // still present but flagged stale → blocked from trading
      }
    }
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      try { await this.pollOnce(); } catch (e) { /* health already records per-venue errors */ }
      if (this.timer) this.timer = setTimeout(tick, this.pollIntervalMs);
    };
    tick();
  }
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  /** Currently-fresh books only (stale books included but flagged). */
  getBooks({ includeStale = true } = {}) {
    const out = {};
    for (const [symbol, venues] of Object.entries(this.books)) {
      for (const [venue, book] of Object.entries(venues)) {
        const stale = (this.now() - (book.ts || 0)) > this.staleAfterMs;
        if (!includeStale && stale) continue;
        out[symbol] = out[symbol] || {};
        out[symbol][venue] = { ...book, stale };
      }
    }
    return out;
  }
  getBook(symbol, venue) {
    const b = this.books[symbol] && this.books[symbol][venue];
    if (!b) return null;
    const stale = (this.now() - (b.ts || 0)) > this.staleAfterMs;
    return { ...b, stale };
  }
  priceHistory(venue, symbol) { return this.history[`${venue}:${symbol}`] || []; }
  snapshot() {
    return {
      ts: this.now(),
      health: Object.values(this.health),
      staleAfterMs: this.staleAfterMs,
      booksFreshness: freshnessSummary(this.books, this.now(), this.staleAfterMs),
    };
  }
  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { for (const fn of this.listeners) { try { fn(evt); } catch { /* listener errors must not kill the poller */ } } }
}

function freshnessSummary(books, now, staleAfterMs) {
  let fresh = 0, stale = 0;
  for (const venues of Object.values(books)) for (const b of Object.values(venues)) {
    ((now - (b.ts || 0)) > staleAfterMs) ? stale++ : fresh++;
  }
  return { fresh, stale };
}

module.exports = { MarketDataService, WATCH_SYMBOLS };
