'use strict';
/**
 * Trade orchestration: preview → explicit user confirmation → execution → reconciliation.
 *
 * Safety properties:
 *  - Previews are single-use, short-lived (PREVIEW_TTL_MS), and bind venue/side/qty/slippage limit.
 *  - Confirm re-fetches market data, re-computes the opportunity from CURRENT books, and re-runs
 *    every risk check. A preview shown 30s ago that no longer clears the bar cannot execute.
 *  - Paper mode (DEFAULT) fills against observed books in the paper ledger — zero real orders.
 *  - Live mode requires: live settings + acknowledgement + per-trade/daily-loss limits + fresh books
 *    + (for this build) a venue with liveTrading capability. Withdrawal permission is NEVER requested.
 *  - Two-leg execution risk is surfaced honestly: if one leg fills and the other fails, the
 *    remaining position is reported loudly as an open leg — nothing is silently hedged.
 */
const crypto = require('crypto');
const { PREVIEW_TTL_MS, STALE_AFTER_MS } = require('./config');
const { evaluateOpportunity } = require('./arbitrage');
const { feeSchedule, withdrawalFee, transferDelayMin } = require('./fees');
const { validateExecution } = require('./risk');
const { LIVE_TRADING_VENUES } = require('./exchanges');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class TradingService {
  constructor({ store, vault, audit, marketData, paperLedger, connectors }) {
    this.store = store; this.vault = vault; this.audit = audit;
    this.marketData = marketData; this.paper = paperLedger;
    this.connectors = Object.fromEntries(connectors.map(c => [c.id, c]));
    this.previews = new Map(); // id -> ticket (in-memory, single-use)
    this._gcTimer = setInterval(() => this._gc(), 30_000);
    if (this._gcTimer.unref) this._gcTimer.unref();
  }

  _feeFor(venue) {
    const o = this.store.get().settings.feeOverrides && this.store.get().settings.feeOverrides[venue];
    return o && typeof o.taker === 'number' ? o.taker : feeSchedule(venue).taker;
  }
  _quoteRate(q) { const r = this.store.get().settings.quoteEquivalence || {}; return typeof r[q] === 'number' ? r[q] : 1.0; }

  _engineOpts() {
    const s = this.store.get().settings;
    return {
      feeFor: (v) => this._feeFor(v),
      maxNotional: s.maxTradeNotional,
      maxSlippagePct: s.maxSlippagePct,
      fundingCostBps: s.fundingCostBps,
      amortizedTransferCost: s.amortizedTransferCost,
      quoteRate: (q) => this._quoteRate(q),
      withdrawalFeeAsset: null, transferDelayMinutes: null,
      venueCapabilities: Object.fromEntries(Object.values(this.connectors).map(c => [c.id, { analysisOnly: !!(c.capabilities && c.capabilities.analysisOnly), liveTrading: !!(c.capabilities && c.capabilities.liveTrading) }])),
      isSimulated: (v) => v.startsWith('sim_'),
    };
  }

  _freshBooks() { return this.marketData.getBooks({ includeStale: true }); }

  /** Find the freshest opportunity matching the requested venues/base, re-evaluated from current books. */
  evaluateFor({ buyVenue, sellVenue, baseAsset, notionalUSD }) {
    const books = this._freshBooks();
    const s = this.store.get().settings;
    const maxNotional = Math.min(notionalUSD || s.maxTradeNotional, s.maxTradeNotional);
    let best = null;
    for (const [symbol, venueBooks] of Object.entries(books)) {
      const [b, qa] = symbol.split('/');
      if (b !== baseAsset) continue;
      const a = venueBooks[buyVenue], bb = venueBooks[sellVenue];
      if (!a || !bb) continue;
      const quoteB = bb.symbol.split('/')[1];
      const opts = { ...this._engineOpts(), maxNotional, baseAsset, quoteA: qa, quoteB, withdrawalFeeAsset: withdrawalFee(b), transferDelayMinutes: transferDelayMin(b) };
      const opp = evaluateOpportunity(symbol, a, bb, opts);
      if (!opp) continue;
      if (!best || opp.netReturnPct > best.netReturnPct) best = opp;
    }
    return best;
  }

  /** STEP 1 — build a confirmation ticket. Does NOT place any order. */
  createPreview({ buyVenue, sellVenue, baseAsset, notionalUSD }) {
    const opp = this.evaluateFor({ buyVenue, sellVenue, baseAsset, notionalUSD });
    if (!opp) throw Object.assign(new Error('No matching market data — venues may be down or the symbol is not quoted. Try again after the next poll.'), { statusCode: 400 });
    const live = this.store.get().settings.mode === 'live';
    const books = this._freshBooks();
    const risk = validateExecution(this.store, books, { buyVenue, sellVenue, notionalUSD: opp.notionalUSD, opportunity: opp, live });
    const ticket = {
      id: `prv_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      expiresAtMs: Date.now() + PREVIEW_TTL_MS,
      used: false,
      mode: live ? 'live' : 'paper',
      opportunity: opp,
      legs: buildLegs(opp),
      totals: {
        notionalUSD: opp.notionalUSD,
        capitalRequiredUSD: opp.capitalRequiredUSD,
        estFeesUSD: opp.totalFeesUSD,
        estFundingUSD: opp.fundingCostUSD,
        estTransferUSD: opp.amortizedTransferCostUSD,
        estNetPnlUSD: opp.netPnlUSD,
        estNetReturnPct: opp.netReturnPct,
        breakEvenMovePct: opp.breakEvenMovePct,
      },
      riskCheck: risk,
      disclaimer: 'Estimates only. Prices move, fees and slippage are estimates, and one leg can fill without the other. Nothing here guarantees profit — arbitrage can and does lose money.',
    };
    this.previews.set(ticket.id, ticket);
    this.audit.log('trade.preview', { id: ticket.id, mode: ticket.mode, buyVenue, sellVenue, baseAsset, notionalUSD: opp.capitalRequiredUSD, estNetPnlUSD: opp.netPnlUSD, riskOk: risk.ok });
    return ticket;
  }

  getPreview(id) { return this.previews.get(id) || null; }

  /** STEP 2 — explicit user confirmation. Re-validates everything against CURRENT data, then executes. */
  async confirmPreview(id) {
    const ticket = this.previews.get(id);
    if (!ticket) throw httpError(404, 'Preview not found or expired. Create a fresh preview.');
    if (ticket.used) throw httpError(409, 'This preview was already used. Create a fresh preview.');
    if (Date.now() > ticket.expiresAtMs) { ticket.used = true; throw httpError(410, 'Preview expired (60s TTL). Create a fresh preview — markets move.'); }

    const opp = this.evaluateFor({ buyVenue: ticket.opportunity.buyVenue, sellVenue: ticket.opportunity.sellVenue, baseAsset: ticket.opportunity.baseAsset, notionalUSD: ticket.opportunity.notionalUSD });
    if (!opp) throw httpError(400, 'Market data no longer available for this pair — order NOT placed.');
    const live = this.store.get().settings.mode === 'live';
    const books = this._freshBooks();
    const risk = validateExecution(this.store, books, { buyVenue: opp.buyVenue, sellVenue: opp.sellVenue, notionalUSD: opp.notionalUSD, opportunity: opp, live });
    if (!risk.ok) {
      this.audit.log('trade.confirm_rejected', { id, reasons: risk.reasons });
      const err = httpError(422, 'Execution blocked by risk checks: ' + risk.reasons.join(' | '));
      err.riskCheck = risk;
      throw err;
    }
    ticket.used = true; // single-use regardless of outcome
    const result = live ? await this._executeLive(ticket, opp) : this._executePaper(ticket, opp);
    result.riskCheck = risk;
    result.executedOpportunity = opp;
    return result;
  }

  _executePaper(ticket, opp) {
    const ledger = this.paper;
    const buySym = opp.buySymbol || `${opp.baseAsset}/${opp.buyQuote}`;
    const sellSym = opp.sellSymbol || `${opp.baseAsset}/${opp.sellQuote}`;
    const qty = opp.quantity;
    const feeBuy = opp.buyFeeUSD, feeSell = opp.sellFeeUSD;
    const priceBuyQ = opp.effBuyPrice / this._quoteRate(opp.buyQuote);   // back to quote ccy
    const priceSellQ = opp.effSellPrice / this._quoteRate(opp.sellQuote);
    const arbGroupId = `arb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    // Pre-check BOTH legs before applying either (avoids half-applied paper state).
    const buyCheck = ledger.checkFill(opp.buyVenue, buySym, 'buy', qty, priceBuyQ, feeBuy);
    const sellCheck = ledger.checkFill(opp.sellVenue, sellSym, 'sell', qty, priceSellQ, feeSell);
    if (!buyCheck.ok || !sellCheck.ok) {
      const reasons = [buyCheck.reason, sellCheck.reason].filter(Boolean);
      this._pushOrders([mkBuy(arbGroupId, 'paper', opp.buyVenue, buySym, qty, 0, 0, feeBuy, 'rejected', reasons.join('; '))]);
      this.audit.log('trade.rejected', { arbGroupId, reasons });
      return { status: 'rejected', mode: 'paper', arbGroupId, reasons, orders: this._ordersFor(arbGroupId) };
    }
    ledger.applyFill(opp.buyVenue, buySym, 'buy', qty, priceBuyQ, feeBuy, this._quoteRate(opp.buyQuote));
    ledger.applyFill(opp.sellVenue, sellSym, 'sell', qty, priceSellQ, feeSell, this._quoteRate(opp.sellQuote));
    this._pushOrders([
      mkBuy(arbGroupId, 'paper', opp.buyVenue, buySym, qty, qty, priceBuyQ, feeBuy, 'filled', null),
      mkBuy(arbGroupId, 'paper', opp.sellVenue, sellSym, qty, qty, priceSellQ, feeSell, 'filled', null, 'sell'),
    ]);
    const roundTripPnl = opp.netPnlUSD;
    this.store.update(s => { s.realizedPnl.push({ ts: new Date().toISOString(), pnl: roundTripPnl, symbol: opp.baseAsset, venues: `${opp.buyVenue}->${opp.sellVenue}`, note: 'Paper arb round trip' }); });
    this.audit.log('trade.filled', { arbGroupId, mode: 'paper', buyVenue: opp.buyVenue, sellVenue: opp.sellVenue, quantity: qty, estNetPnlUSD: roundTripPnl });
    return { status: 'filled', mode: 'paper', arbGroupId, quantity: qty, estNetPnlUSD: roundTripPnl, orders: this._ordersFor(arbGroupId) };
  }

  _pushOrders(list) { this.store.update(s => { for (const o of list) s.orders.push(o); }); }

  async _executeLive(ticket, opp) {
    const arbGroupId = `arb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const buySym = opp.buySymbol || `${opp.baseAsset}/${opp.buyQuote}`;
    const sellSym = opp.sellSymbol || `${opp.baseAsset}/${opp.sellQuote}`;
    const buyConnector = this.connectors[opp.buyVenue], sellConnector = this.connectors[opp.sellVenue];
    const results = { arbGroupId, mode: 'live', legs: [] };

    if (!buyConnector || !sellConnector || !LIVE_TRADING_VENUES.has(opp.buyVenue) || !LIVE_TRADING_VENUES.has(opp.sellVenue)) {
      throw httpError(400, 'A venue in this ticket does not support live execution in this build.');
    }
    const buyCreds = this.vault.readCredential(this.store, opp.buyVenue);
    const sellCreds = this.vault.readCredential(this.store, opp.sellVenue);
    if (!buyCreds || !sellCreds) {
      throw httpError(400, `Missing API credentials for ${!buyCreds ? opp.buyVenue : opp.sellVenue}. Add trading-only keys in Settings first.`);
    }

    // LEG 1 — buy on buyVenue (market buy with quoteOrderQty where supported)
    let buyOrder = null;
    try {
      buyOrder = await buyConnector.placeOrder(buyCreds, { symbol: buySym, side: 'buy', quantity: opp.quantity, type: 'MARKET', quoteOrderQty: opp.capitalRequiredUSD });
      buyOrder = await this._reconcile(buyConnector, buyCreds, buySym, buyOrder.exchangeOrderId);
      results.legs.push({ role: 'buy', ...buyOrder });
    } catch (e) {
      results.status = 'failed';
      results.failReason = `BUY leg on ${opp.buyVenue} failed: ${e.message}`;
      results.legRisk = 'No position opened on the buy venue. The sell venue was not touched.';
      this.audit.log('trade.leg_failed', { arbGroupId, leg: 'buy', error: e.message });
      this._persistLiveResult(ticket, opp, arbGroupId, results);
      return results;
    }
    // LEG 2 — sell the ACTUAL filled base quantity on sellVenue
    const filledQty = buyOrder.filledQty > 0 ? buyOrder.filledQty : opp.quantity;
    let sellOrder = null;
    try {
      sellOrder = await sellConnector.placeOrder(sellCreds, { symbol: sellSym, side: 'sell', quantity: filledQty, type: 'MARKET' });
      sellOrder = await this._reconcile(sellConnector, sellCreds, sellSym, sellOrder.exchangeOrderId);
      results.legs.push({ role: 'sell', ...sellOrder });
    } catch (e) {
      results.status = 'hedge_required';
      results.failReason = `SELL leg on ${opp.sellVenue} failed after buy filled: ${e.message}`;
      results.legRisk = `OPEN POSITION: you bought ${filledQty} ${opp.baseAsset} on ${opp.buyVenue} and could NOT sell on ${opp.sellVenue}. This is price risk, not arbitrage. Inspect balances and unwind manually or engage the kill switch.`;
      this.audit.log('trade.hedge_required', { arbGroupId, error: e.message, openQty: filledQty, asset: opp.baseAsset, venue: opp.buyVenue });
      this._persistLiveResult(ticket, opp, arbGroupId, results);
      return results;
    }
    results.status = 'filled';
    if (sellOrder.filledQty < filledQty * 0.999) {
      results.status = 'partial';
      results.legRisk = `Buy filled ${filledQty} but sell filled only ${sellOrder.filledQty} — residual ${(filledQty - sellOrder.filledQty).toFixed(8)} ${opp.baseAsset} remains on ${opp.buyVenue}.`;
    }
    const estPnl = (sellOrder.avgFillPrice * (sellOrder.filledQty || filledQty)) - (buyOrder.cost || buyOrder.avgFillPrice * filledQty);
    this.store.update(s => { s.realizedPnl.push({ ts: new Date().toISOString(), pnl: estPnl || opp.netPnlUSD, symbol: opp.baseAsset, venues: `${opp.buyVenue}->${opp.sellVenue}`, note: results.status === 'filled' ? 'Live arb round trip' : 'Live arb (partial)' }); });
    this.audit.log('trade.filled', { arbGroupId, mode: 'live', buyVenue: opp.buyVenue, sellVenue: opp.sellVenue, quantity: filledQty, estPnl });
    this._persistLiveResult(ticket, opp, arbGroupId, results);
    return results;
  }

  async _reconcile(connector, creds, symbol, orderId, attempts = 4) {
    if (!orderId) return { exchangeOrderId: null, status: 'unknown', filledQty: 0 };
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await connector.getOrder(creds, { symbol, orderId });
        if (last.status === 'filled' || last.status === 'cancelled' || last.status === 'rejected' || last.status === 'expired') break;
      } catch (e) { last = { ...(last || {}), reconcileError: e.message, status: last && last.status || 'unknown' }; }
      if (i < attempts - 1) await sleep(700);
    }
    return last;
  }

  _persistLiveResult(ticket, opp, arbGroupId, results) {
    const mode = 'live';
    this.store.update(s => {
      for (const leg of results.legs) {
        s.orders.push(mkOrder({ arbGroup: arbGroupId, mode, venue: leg.venue || (leg.role === 'buy' ? opp.buyVenue : opp.sellVenue), symbol: leg.symbol || (leg.role === 'buy' ? opp.buySymbol : opp.sellSymbol), side: leg.role, quantity: leg.quantity ?? (leg.role === 'buy' ? opp.quantity : (leg.filledQty ?? opp.quantity)), filledQty: leg.filledQty ?? 0, avgFillPrice: leg.avgFillPrice ?? 0, feeUSD: leg.fee ?? 0, status: leg.status || 'unknown', type: 'market', source: 'live', note: results.legRisk }));
      }
      if (!results.legs.length && results.status === 'failed') {
        s.orders.push(mkOrder({ arbGroup: arbGroupId, mode, venue: opp.buyVenue, symbol: opp.buySymbol, side: 'buy', quantity: opp.quantity, filledQty: 0, avgFillPrice: 0, feeUSD: 0, status: 'rejected', type: 'market', source: 'live', note: results.failReason }));
      }
    });
  }

  _ordersFor(arbGroupId) { return this.store.get().orders.filter(o => o.arbGroup === arbGroupId); }

  /** Cancel a single order (paper or live). */
  async cancelOrder(orderId) {
    const s = this.store.get();
    const idx = s.orders.findIndex(o => o.id === orderId);
    if (idx === -1) throw httpError(404, 'Order not found');
    const order = s.orders[idx];
    if (order.status !== 'open' && order.status !== 'partial') throw httpError(409, `Order is ${order.status} — nothing to cancel.`);
    if (order.mode === 'live' && order.source === 'live') {
      const connector = this.connectors[order.venue];
      const creds = this.vault.readCredential(this.store, order.venue);
      if (!connector || !creds) throw httpError(400, 'Cannot reconcile venue for cancellation.');
      await connector.cancelOrder(creds, { symbol: order.symbol, orderId: order.exchangeOrderId });
    }
    this.store.update(st => { st.orders[idx] = { ...order, status: 'cancelled', updatedAt: new Date().toISOString() }; });
    this.audit.log('order.cancelled', { orderId, venue: order.venue, symbol: order.symbol });
    return this.store.get().orders[idx];
  }

  /** KILL SWITCH — halt everything, cancel what is cancellable. */
  async engageKillSwitch(engage, reason) {
    this.store.update(s => { s.killSwitch = !!engage; });
    const summary = { engaged: !!engage, cancelled: [], failed: [] };
    if (engage) {
      // Cancel open paper orders (records only; paper fills are instant)
      this.store.update(s => { for (const o of s.orders) if (o.status === 'open' || o.status === 'partial') o.status = 'cancelled'; });
      // Cancel open LIVE orders on venues with credentials
      for (const [venue, connector] of Object.entries(this.connectors)) {
        if (!LIVE_TRADING_VENUES.has(venue)) continue;
        const creds = this.vault.readCredential(this.store, venue);
        if (!creds) continue;
        try {
          const open = await connector.getOpenOrders(creds);
          for (const o of open) {
            try { await connector.cancelOrder(creds, { symbol: o.symbol, orderId: o.exchangeOrderId }); summary.cancelled.push({ venue, orderId: o.exchangeOrderId }); }
            catch (e) { summary.failed.push({ venue, orderId: o.exchangeOrderId, error: e.message }); }
          }
        } catch (e) { summary.failed.push({ venue, error: e.message }); }
      }
    }
    this.audit.log(engage ? 'kill_switch.engaged' : 'kill_switch.disengaged', { reason, cancelled: summary.cancelled.length, failed: summary.failed.length });
    return summary;
  }

  _gc() { const now = Date.now(); for (const [id, p] of this.previews) if (now > p.expiresAtMs + 300_000) this.previews.delete(id); }
}

function buildLegs(opp) {
  const buySym = opp.buySymbol || `${opp.baseAsset}/${opp.buyQuote}`;
  const sellSym = opp.sellSymbol || `${opp.baseAsset}/${opp.sellQuote}`;
  const qty = opp.quantity;
  const slipBpsGuard = (p) => p; // worst-case prices derive from slippage guard enforced book-side
  return [
    { role: 'buy', venue: opp.buyVenue, symbol: buySym, side: 'buy', type: 'market', quantity: qty, worstCasePriceUSD: opp.effBuyPrice * 1.005, estPriceUSD: opp.effBuyPrice, estFeeUSD: opp.buyFeeUSD, estNotionalUSD: qty * opp.effBuyPrice, quote: opp.buyQuote },
    { role: 'sell', venue: opp.sellVenue, symbol: sellSym, side: 'sell', type: 'market', quantity: qty, worstCasePriceUSD: opp.effSellPrice * 0.995, estPriceUSD: opp.effSellPrice, estFeeUSD: opp.sellFeeUSD, estNotionalUSD: qty * opp.effSellPrice, quote: opp.sellQuote },
  ];
}
function mkOrder(o) {
  return { id: `ord_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`, ts: new Date().toISOString(), createdAt: new Date().toISOString(), ...o };
}
function mkBuy(arbGroup, mode, venue, symbol, quantity, filledQty, avgFillPrice, feeUSD, status, note, side = 'buy') {
  return mkOrder({ arbGroup, mode, venue, symbol, side, quantity, filledQty, avgFillPrice, feeUSD, status, type: 'market', source: mode, note });
}
function httpError(status, message) { const e = new Error(message); e.statusCode = status; return e; }

module.exports = { TradingService };
