'use strict';
/** Shared HTTP helper for exchange REST calls: timeout, typed errors, rate-limit detection. */
const { FETCH_TIMEOUT_MS } = require('../config');

class ExchangeApiError extends Error {
  constructor(venue, message, { status = 0, rateLimited = false, outage = false } = {}) {
    super(message);
    this.name = 'ExchangeApiError';
    this.venue = venue;
    this.status = status;
    this.rateLimited = rateLimited;
    this.outage = outage;
  }
}

async function fetchJson(url, { venue, method = 'GET', headers = {}, body = undefined, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const rateLimited = res.status === 429 || res.status === 418;
      const outage = res.status >= 500;
      const msg = (json && (json.msg || json.message || json.error || (Array.isArray(json.e) && json.e[1]))) || `HTTP ${res.status}`;
      throw new ExchangeApiError(venue, String(msg), { status: res.status, rateLimited, outage });
    }
    return { json, latencyMs: Date.now() - started };
  } catch (e) {
    if (e.name === 'AbortError') throw new ExchangeApiError(venue, `Request to ${venue} timed out after ${timeoutMs}ms`, { outage: true });
    if (e instanceof ExchangeApiError) throw e;
    throw new ExchangeApiError(venue, `Network error calling ${venue}: ${e.message}`, { outage: true });
  } finally {
    clearTimeout(t);
  }
}

/** Canonical "BTC/USDT" -> venue-specific format */
const toFlat = (s) => s.replace('/', '');
const toDash = (s) => s.replace('/', '-');

module.exports = { fetchJson, ExchangeApiError, toFlat, toDash };
