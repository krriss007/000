'use strict';
/**
 * Paper ledger — simulates balances and fills against observed order books with slippage and fees.
 * Paper mode NEVER touches a real exchange endpoint.
 * Spot arb assumes PRE-FUNDED inventory on both sides, so balances start with quote + base stock.
 */
const initialPaperBalances = () => {
  const baseStock = { BTC: 0.06, ETH: 1.6, SOL: 16, XRP: 1600, ADA: 2200, DOGE: 6000 };
  const bal = {};
  for (const v of ['sim_binance', 'sim_kraken', 'sim_coinbase', 'binance', 'kraken', 'coinbase']) {
    bal[v] = { quote: 25000, base: { ...baseStock } };
  }
  return bal;
};

class PaperLedger {
  constructor(store) { this.store = store; }

  getBalances() { return this.store.get().paperBalances; }

  reset() { this.store.update(s => { s.paperBalances = initialPaperBalances(); }); return this.getBalances(); }

  /** Check both legs can be covered BEFORE any fill is applied. */
  checkFill(venue, symbol, side, quantity, price, feeUSD) {
    const s = this.store.get().settings;
    const [base, rawQuote] = symbol.split('/');
    const bal = this.store.get().paperBalances[venue];
    if (!bal) return { ok: false, reason: `No paper account for venue ${venue}` };
    if (side === 'buy') {
      const quoteRate = (s.quoteEquivalence && s.quoteEquivalence[rawQuote]) || 1;
      const costUSD = quantity * price * quoteRate + feeUSD; // bal.quote is tracked in USD terms
      if (bal.quote < costUSD) return { ok: false, reason: `Insufficient paper USD on ${venue}: need $${costUSD.toFixed(2)}, have $${bal.quote.toFixed(2)}` };
      return { ok: true };
    }
    const have = bal.base[base] || 0;
    if (have + 1e-12 < quantity) return { ok: false, reason: `Insufficient paper ${base} on ${venue}: need ${quantity}, have ${have}` };
    return { ok: true };
  }

  /** Apply a single leg fill. Caller must pre-check BOTH legs first (see checkFill). */
  applyFill(venue, symbol, side, quantity, priceQuoted, feeUSD, quoteToUSD = 1) {
    return this.store.update(s => {
      const [base, rawQuote] = symbol.split('/');
      const bal = s.paperBalances[venue];
      if (side === 'buy') {
        bal.quote -= (quantity * priceQuoted) * quoteToUSD + feeUSD;
        bal.quote = Math.round(bal.quote * 100) / 100;
        bal.base[base] = (bal.base[base] || 0) + quantity;
      } else {
        bal.base[base] = (bal.base[base] || 0) - quantity;
        bal.quote += (quantity * priceQuoted) * quoteToUSD - feeUSD; // feeUSD is already in USD
        bal.quote = Math.round(bal.quote * 100) / 100;
      }
      return bal;
    });
  }
}
module.exports = { PaperLedger, initialPaperBalances };
