'use strict';
/**
 * Fee models and network/transfer cost table.
 * Defaults reflect commonly published retail fee schedules — ALWAYS verify against the
 * exchange's current fee page for your tier. Every value here is overridable in Settings.
 * All rates are fractions (0.001 = 0.1%). Amounts are in the quote currency unless noted.
 */
const FEE_SCHEDULES = {
  binance: { taker: 0.001, maker: 0.001, label: 'Binance Spot (standard 0.10%/0.10%, BNB discount not assumed)' },
  kraken:  { taker: 0.0026, maker: 0.0016, label: 'Kraken Spot (Starter tier 0.26% taker / 0.16% maker)' },
  coinbase:{ taker: 0.006, maker: 0.004, label: 'Coinbase Advanced Trade (<$10k tier 0.60% taker / 0.40% maker)' },
  sim_binance:  { taker: 0.001, maker: 0.001, label: 'Simulated Binance (mirrors 0.10%/0.10%)' },
  sim_kraken:   { taker: 0.0026, maker: 0.0016, label: 'Simulated Kraken (mirrors 0.26%/0.16%)' },
  sim_coinbase: { taker: 0.006, maker: 0.004, label: 'Simulated Coinbase (mirrors 0.60%/0.40%)' },
};

// Withdrawal/transfer costs in the *asset* being withdrawn. Used for visibility of
// rebalancing costs; spot arb assumes PRE-FUNDED accounts (no transfer in the hot path).
const WITHDRAWAL_FEES = {
  BTC: 0.0002, ETH: 0.0012, SOL: 0.01, XRP: 0.1, ADA: 1.0, DOGE: 5.0, USDT: 1.0, USDC: 1.0,
};

// Typical on-chain / internal-transfer delay estimates in minutes (highly variable; shown as assumptions).
const TRANSFER_DELAYS_MIN = {
  BTC: 30, ETH: 5, SOL: 2, XRP: 1, ADA: 5, DOGE: 10, USDT: 5, USDC: 5,
};

const feeSchedule = (venue) => FEE_SCHEDULES[venue] || { taker: 0.002, maker: 0.002, label: 'Assumed 0.20%/0.20% (unknown venue — configure in Settings)' };
const withdrawalFee = (asset) => (asset in WITHDRAWAL_FEES ? WITHDRAWAL_FEES[asset] : null);
const transferDelayMin = (asset) => (asset in TRANSFER_DELAYS_MIN ? TRANSFER_DELAYS_MIN[asset] : null);

module.exports = { FEE_SCHEDULES, WITHDRAWAL_FEES, TRANSFER_DELAYS_MIN, feeSchedule, withdrawalFee, transferDelayMin };
