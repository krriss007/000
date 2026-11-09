'use strict';
/**
 * Arbitrage opportunity engine — PURE functions, no I/O. Every number shown in the UI
 * comes from here, so it is exhaustively unit-tested.
 *
 * All prices in the book walker are raw venue prices. When venues quote different but
 * nominally-pegged quotes (e.g. USD vs USDT), both legs are normalized to USD with the
 * configured quote rates (settings.quoteEquivalence) and the assumption is surfaced.
 *
 * IMPORTANT HONESTY RULES baked into every result:
 *  - Net figures ALWAYS deduct taker fees on both legs, slippage (via book-walk), funding cost,
 *    and the configured amortized transfer/rebalance cost.
 *  - There is no "guaranteed" profit anywhere. Results are estimates with assumptions & warnings.
 *  - Break-even move shows how far price can move against you before the trade loses money.
 */

/**
 * Walk a book side to fill `targetQty` (base asset).
 * @param {Array<[number,number]>} levels  asks ascending or bids descending
 * @param {number} targetQty
 * @param {"buy"|"sell"} side
 * @returns {{qty:number, avgPrice:number, total:number, fullyFilled:boolean}}
 */
function walkBook(levels, targetQty, side) {
  let remaining = targetQty, qty = 0, total = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(size, remaining);
    qty += take; total += take * price; remaining -= take;
  }
  return { qty, avgPrice: qty > 0 ? total / qty : 0, total, fullyFilled: remaining <= 1e-12 };
}

/** Max quantity executable on a book side before price moves more than `slipPct` from top. */
function slippageCapQty(levels, side, slipPct) {
  if (!levels.length) return 0;
  const top = levels[0][0];
  const limit = side === 'buy' ? top * (1 + slipPct / 100) : top * (1 - slipPct / 100);
  let qty = 0;
  for (const [price, size] of levels) {
    if (side === 'buy' ? price > limit : price < limit) break;
    qty += size;
  }
  return qty;
}

/**
 * Evaluate one directed opportunity: BUY base on `buyVenue`, SELL base on `sellVenue`.
 * @param {object} a  ask-side book (venue you buy on)
 * @param {object} b  bid-side book (venue you sell on)
 */
function evaluateOpportunity(symbol, a, b, opts) {
  const {
    feeFor,                    // (venueId) => taker rate (fraction)
    maxNotional,               // quote currency cap per trade
    maxSlippagePct,            // book-walk limit from top of book
    fundingCostBps,            // carry/funding assumption for the holding window
    amortizedTransferCost,     // quote currency, per round trip
    quoteRate,                 // (quote) => USD multiplier
    baseAsset, quoteA, quoteB,
    withdrawalFeeAsset,        // in base asset units (display)
    transferDelayMinutes,      // display
    venueCapabilities = {},    // venue -> { analysisOnly, liveTrading }
    isSimulated = () => false,
  } = opts;

  const warnings = [];
  const assumptions = [];
  const rateA = quoteRate(quoteA), rateB = quoteRate(quoteB);
  const mixedQuotes = quoteA !== quoteB;
  assumptions.push(mixedQuotes
    ? `Quotes normalized to USD using ${quoteA}=${rateA}, ${quoteB}=${rateB} (stablecoin parity — configurable in Settings)`
    : `Same quote (${quoteA}) on both venues`);

  const asks = a.asks || [], bids = b.bids || [];
  if (!asks.length || !bids.length) {
    return null;
  }
  const bestAsk = asks[0][0], bestBid = bids[0][0];
  const nBestAsk = bestAsk * rateA, nBestBid = bestBid * rateB;
  const grossSpreadPct = (nBestBid / nBestAsk - 1) * 100;

  // Quantity: cap by notional, both slippage bands
  const notionalQty = maxNotional / nBestAsk;
  const buyCap = slippageCapQty(asks, 'buy', maxSlippagePct);
  const sellCap = slippageCapQty(bids, 'sell', maxSlippagePct);
  let qty = Math.min(notionalQty, buyCap, sellCap);
  const depthLimited = qty < notionalQty;
  if (qty <= 0) {
    warnings.push('No executable depth within slippage guard');
    qty = Math.min(notionalQty, asks.reduce((s, l) => s + l[1], 0), bids.reduce((s, l) => s + l[1], 0));
  }

  const buy = walkBook(asks, qty, 'buy');
  const sell = walkBook(bids, qty, 'sell');
  const execQty = Math.min(buy.qty, sell.qty);
  const buyTotalN = walkBook(asks, execQty, 'buy').total * rateA;
  const sellTotalN = walkBook(bids, execQty, 'sell').total * rateB;
  const effBuy = execQty > 0 ? buyTotalN / execQty : 0;   // USD per unit
  const effSell = execQty > 0 ? sellTotalN / execQty : 0; // USD per unit

  const buyFeeRate = feeFor(a.venue), sellFeeRate = feeFor(b.venue);
  const buyFee = buyTotalN * buyFeeRate;
  const sellFee = sellTotalN * sellFeeRate;
  const fundingCost = buyTotalN * (fundingCostBps / 10000);
  const totalOutlay = buyTotalN + buyFee + fundingCost;
  const netProceeds = sellTotalN - sellFee;
  const grossPnl = sellTotalN - buyTotalN;
  const netPnl = netProceeds - totalOutlay - amortizedTransferCost;
  const netReturnPct = totalOutlay > 0 ? (netPnl / totalOutlay) * 100 : 0;

  // Break-even: sell-side price that makes net == 0, and how far current price can drop first.
  const breakEvenSellPriceUSD = execQty > 0 ? (totalOutlay + amortizedTransferCost) / (execQty * (1 - sellFeeRate)) : 0;
  const breakEvenMovePct = effSell > 0 ? ((effSell - breakEvenSellPriceUSD) / effSell) * 100 : 0;

  assumptions.push('PRE-FUNDED accounts on both venues — no transfer in the hot path; rebalance cost amortized at ' + amortizedTransferCost.toFixed(2) + ' USD/round trip');
  assumptions.push(`Funding/carry assumption ${fundingCostBps} bps of buy notional`);
  assumptions.push(`Taker fees: buy ${(buyFeeRate * 100).toFixed(3)}%, sell ${(sellFeeRate * 100).toFixed(3)}%`);
  assumptions.push('Execution assumed simultaneous or near-simultaneous; leg risk is real if one leg fills and the other does not');
  assumptions.push('Order book depth at observation time only — it can change before your order lands');
  if (withdrawalFeeAsset != null) assumptions.push(`Rebalance path: withdraw ${baseAsset} (~${withdrawalFeeAsset} ${baseAsset} fee, ~${transferDelayMinutes} min on-chain) — delays & costs erode edge`);

  if (depthLimited) warnings.push('Size capped by order-book depth / slippage guard, not by your max notional');
  if (execQty * effBuy < 100) warnings.push('Very small executable size (< $100) — fixed costs dominate');
  if (mixedQuotes) warnings.push('Mixed quotes compared under stablecoin-parity assumption');
  if (venueCapabilities[a.venue] && venueCapabilities[a.venue].analysisOnly) warnings.push(`${a.venue}: analysis-only venue — live execution not supported`);
  if (venueCapabilities[b.venue] && venueCapabilities[b.venue].analysisOnly) warnings.push(`${b.venue}: analysis-only venue — live execution not supported`);
  if (isSimulated(a.venue) || isSimulated(b.venue)) warnings.push('Simulated venue involved — figures are illustrative, not real market data');
  if (grossSpreadPct <= 0) warnings.push('Negative gross spread — sell side is cheaper; this direction only loses money');

  return {
    id: `${a.symbol}:${a.venue}->${b.venue}:${baseAsset}`,
    symbol, baseAsset,
    buyVenue: a.venue, sellVenue: b.venue,
    buySymbol: a.symbol, sellSymbol: b.symbol,
    buyQuote: quoteA, sellQuote: quoteB,
    bestAskRaw: bestAsk, bestBidRaw: bestBid,
    effBuyPrice: effBuy, effSellPrice: effSell,
    grossSpreadPct,
    quantity: execQty,
    notionalUSD: execQty * effBuy,
    buyFeeUSD: buyFee, sellFeeUSD: sellFee, fundingCostUSD: fundingCost, amortizedTransferCostUSD: amortizedTransferCost,
    totalFeesUSD: buyFee + sellFee,
    capitalRequiredUSD: totalOutlay,
    grossPnlUSD: grossPnl, netPnlUSD: netPnl, netReturnPct, netReturnBps: netReturnPct * 100,
    breakEvenMovePct,
    depthLimited,
    buyLatencyMs: a.latencyMs, sellLatencyMs: b.latencyMs,
    bookTs: Math.min(a.ts || 0, b.ts || 0),
    source: a.source === 'live' && b.source === 'live' ? 'live' : (a.source === 'simulated' || b.source === 'simulated' ? 'simulated-or-mixed' : a.source),
    withdrawalFeeBase: withdrawalFeeAsset, transferDelayMinutes,
    assumptions, warnings,
  };
}

/**
 * Evaluate all directed cross-venue opportunities across every supplied book.
 * Books may quote the same base in different quotes (e.g. Coinbase BTC/USD vs Binance BTC/USDT);
 * they are compared under the configured quote-equivalence rates and flagged as mixed-quote.
 * @param {Object<string, Object<string, object>>} booksBySymbol  symbol -> venue -> normalized book
 */
function evaluateAll(booksBySymbol, opts) {
  // Group by BASE asset across all quote currencies.
  const baseGroups = {}; // base -> [ [symbol, venue, book, quote] ]
  for (const [symbol, venueBooks] of Object.entries(booksBySymbol)) {
    const [baseAsset, quote] = String(symbol).split('/');
    for (const [venue, book] of Object.entries(venueBooks || {})) {
      (baseGroups[baseAsset] = baseGroups[baseAsset] || []).push({ symbol, venue, book, quote });
    }
  }
  const results = [];
  for (const [baseAsset, entries] of Object.entries(baseGroups)) {
    for (const A of entries) for (const B of entries) {
      if (A.venue === B.venue && A.quote === B.quote) continue;
      if (A.venue === B.venue) continue; // never "arb" a venue against itself
      const opp = evaluateOpportunity(
        `${baseAsset}/${A.quote}`,
        A.book, B.book,
        { ...opts, baseAsset, quoteA: A.quote, quoteB: B.quote }
      );
      if (opp) { opp.buySymbol = A.symbol; opp.sellSymbol = B.symbol; results.push(opp); }
    }
  }
  results.sort((x, y) => y.netReturnPct - x.netReturnPct);
  return results;
}

module.exports = { walkBook, slippageCapQty, evaluateOpportunity, evaluateAll };
