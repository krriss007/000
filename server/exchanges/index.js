'use strict';
/**
 * Connector registry.
 *
 * ALL connectors are always constructed (authenticated calls — credential verification,
 * live execution — must work regardless of the market-data mode).
 * DATA_MODE only controls which venues are POLLED for market data:
 *   'simulated' → simulated venues only (development default)
 *   'live'      → real public APIs only; failures are visible, simulator is NOT used
 *   'auto'      → real venues + simulated venues; failing venues are flagged, never silently faked
 *
 * Safety: in 'simulated' mode no live order books exist, so previews can only match
 * simulated venues — and simulated venues can never pass the live-execution venue check.
 * Real orders require DATA_MODE=live|auto AND live mode + acknowledgement in Settings.
 */
const { DATA_MODE } = require('../config');
const { SimulatedConnector } = require('./simulated');
const { BinanceConnector } = require('./binance');
const { KrakenConnector } = require('./kraken');
const { CoinbaseConnector } = require('./coinbase');

function buildConnectors(env = process.env) {
  return [
    new SimulatedConnector('sim_binance'),
    new SimulatedConnector('sim_kraken'),
    new SimulatedConnector('sim_coinbase'),
    new BinanceConnector(),
    new KrakenConnector(),
    new CoinbaseConnector(),
  ];
}

/** Which connectors this DATA_MODE polls for market data. */
function pollingFilter(mode = DATA_MODE) {
  const m = String(mode).toLowerCase();
  if (m === 'simulated') return (c) => c.id.startsWith('sim_');
  if (m === 'live') return (c) => !c.id.startsWith('sim_');
  return () => true; // auto
}

/** Which venues are allowed for LIVE order submission in this build. */
const LIVE_TRADING_VENUES = new Set(['binance', 'kraken']);

module.exports = { buildConnectors, pollingFilter, LIVE_TRADING_VENUES };
