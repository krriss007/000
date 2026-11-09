'use strict';
/**
 * Risk engine — the gate every order must pass. Pure logic + store reads; no I/O to exchanges.
 * Fail-closed: any doubt → order blocked with explicit reasons.
 */
const { LIVE_TRADING_VENUES } = require('./exchanges');

const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

function realizedPnlToday(store, now = Date.now()) {
  const today = utcDay(now);
  return store.get().realizedPnl.filter(e => utcDay(new Date(e.ts).getTime()) === today).reduce((s, e) => s + (e.pnl || 0), 0);
}

/**
 * Validate a prospective two-leg arbitrage execution.
 * @returns {{ ok: boolean, reasons: string[], checks: Array<{name:string, ok:boolean, detail:string}> }}
 */
function validateExecution(store, books, { buyVenue, sellVenue, notionalUSD, opportunity, live }) {
  const s = store.get().settings;
  const now = Date.now();
  const checks = [];
  const block = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  // 1. Kill switch
  if (store.get().killSwitch) block('Kill switch', 'Kill switch is ENGAGED — all order submission is blocked');
  else pass('Kill switch', 'Not engaged');

  // 2. Mode & live acknowledgement
  if (live) {
    if (s.mode !== 'live') block('Live mode', 'Application is in paper mode — enable live trading deliberately and acknowledge risks first');
    else if (!s.liveTradingAcknowledged) block('Live acknowledgement', 'Live trading not acknowledged');
    else pass('Live mode', 'Live mode enabled and acknowledged');
    for (const v of [buyVenue, sellVenue]) {
      if (!LIVE_TRADING_VENUES.has(v)) block('Venue capability', `${v} does not support live execution in this build (analysis-only or simulated)`);
    }
  } else {
    pass('Mode', 'Paper trading');
  }

  // 3. Per-trade notional cap (position value, excluding fees)
  if (!(notionalUSD > 0)) block('Quantity', 'Notional must be positive');
  else if (notionalUSD > s.maxTradeNotional) block('Per-trade limit', `Requested $${notionalUSD.toFixed(2)} exceeds max per-trade notional $${s.maxTradeNotional}`);
  else pass('Per-trade limit', `$${notionalUSD.toFixed(2)} ≤ $${s.maxTradeNotional}`);

  // 4. Daily loss limit (realized, UTC day)
  const pnlToday = realizedPnlToday(store, now);
  const lossToday = -Math.min(0, pnlToday);
  if (lossToday >= s.maxDailyLoss) block('Daily loss limit', `Realized loss today $${lossToday.toFixed(2)} reached limit $${s.maxDailyLoss} — trading halted for the day`);
  else pass('Daily loss limit', `Realized P&L today: ${pnlToday >= 0 ? '+' : ''}$${pnlToday.toFixed(2)} (limit −$${s.maxDailyLoss})`);

  // 5. Max open positions (count open buy/sell leg orders)
  const openCount = store.get().orders.filter(o => o.status === 'open' || o.status === 'partial').length;
  if (openCount >= s.maxOpenPositions * 2) block('Open orders', `${openCount} open legs ≥ ${s.maxOpenPositions} positions cap`);
  else pass('Open orders', `${openCount} open legs`);

  // 6. Staleness — books must exist and be fresh
  for (const [role, venue] of [['buy', buyVenue], ['sell', sellVenue]]) {
    const sym = role === 'buy' ? (opportunity && opportunity.buySymbol) : (opportunity && opportunity.sellSymbol);
    const book = sym && books[sym] && books[sym][venue];
    if (!book) { block(`Stale data (${role})`, `No order book for ${sym || '?'} on ${venue} — cannot verify price`); continue; }
    const ageMs = now - (book.ts || 0);
    if (book.stale || ageMs > require('./config').STALE_AFTER_MS) block(`Stale data (${role})`, `Quote from ${venue} is ${Math.round(ageMs / 1000)}s old — refusing to trade on stale data`);
    else pass(`Fresh data (${role})`, `${venue} quote ${Math.round(ageMs / 1000)}s old`);
  }

  // 7. Positive expected net after fees/slippage — we do not place knowingly-losing trades by default
  if (opportunity) {
    if (opportunity.netPnlUSD <= 0) block('Net edge', `Estimated net P&L is ${opportunity.netPnlUSD.toFixed(2)} USD after fees, slippage, funding and transfer costs — not positive`);
    else pass('Net edge', `Estimated net +$${opportunity.netPnlUSD.toFixed(2)} (${opportunity.netReturnPct.toFixed(3)}%)`);
    if (opportunity.warnings && opportunity.warnings.some(w => /analysis-only/.test(w))) {
      if (live) block('Venue capability', 'Opportunity involves an analysis-only venue');
    }
  }

  const reasons = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
  return { ok: reasons.length === 0, reasons, checks, pnlToday };
}

/** Risk snapshot for the UI (limits, usage today). */
function riskStatus(store) {
  const s = store.get().settings;
  const pnlToday = realizedPnlToday(store);
  return {
    mode: s.mode,
    liveTradingAcknowledged: !!s.liveTradingAcknowledged,
    killSwitch: store.get().killSwitch,
    maxTradeNotional: s.maxTradeNotional,
    maxDailyLoss: s.maxDailyLoss,
    maxOpenPositions: s.maxOpenPositions,
    pnlTodayUSD: pnlToday,
    dailyLossRemainingUSD: Math.max(0, s.maxDailyLoss - Math.max(0, -pnlToday)),
    openLegs: store.get().orders.filter(o => o.status === 'open' || o.status === 'partial').length,
  };
}

module.exports = { validateExecution, riskStatus, realizedPnlToday, utcDay };
