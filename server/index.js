'use strict';
/**
 * ArbScope — entry point. Wires store, vault, audit, connectors, market data, trading, HTTP.
 */
const path = require('path');
const express = require('express');
const config = require('./config');
const { Store } = require('./store');
const { Vault } = require('./vault');
const { makeAudit } = require('./audit');
const { buildConnectors, pollingFilter } = require('./exchanges');
const { MarketDataService } = require('./marketData');
const { PaperLedger } = require('./paper');
const { TradingService } = require('./trading');
const { buildRouter } = require('./routes');

const store = new Store(config.DATA_DIR);
const audit = makeAudit(store);
const vault = new Vault(config.MASTER_KEY);
const connectors = buildConnectors();
const connectorsById = Object.fromEntries(connectors.map(c => [c.id, c]));
const venueIds = connectors.map(c => c.id);

const marketData = new MarketDataService({ connectors, store, shouldPoll: pollingFilter(config.DATA_MODE) });
const paper = new PaperLedger(store);
const trading = new TradingService({ store, vault, audit, marketData, paperLedger: paper, connectors });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// Security headers (frontend uses only self-hosted JS/CSS, no inline scripts)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

// Lightweight rate limit for API mutations (in-memory, per IP)
const buckets = new Map();
setInterval(() => buckets.clear(), 60_000).unref();
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const key = req.ip || 'unknown';
  const n = (buckets.get(key) || 0) + 1;
  buckets.set(key, n);
  if (n > 120) return res.status(429).json({ error: 'Rate limit exceeded — slow down.' });
  next();
});

const dataMode = config.DATA_MODE;
app.use('/api', buildRouter({ store, vault, audit, marketData, trading, connectorsById, venueIds, dataMode }));

// Error handler — never leaks internals in production
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
  const status = err.statusCode || 500;
  res.status(status).json({ error: status === 500 && config.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`[arbscope] listening on http://${config.HOST}:${config.PORT} (data mode: ${dataMode}, env: ${config.NODE_ENV})`);
  if (config.masterKeySource !== 'env') console.log('[arbscope] WARNING: ARBSCOPE_MASTER_KEY not set — using an ephemeral dev key; stored credentials will not survive restart.');
  if (dataMode !== 'simulated') console.log('[arbscope] Live public market data enabled where reachable; failing venues are flagged, never silently simulated.');
  audit.log('app.start', { dataMode, env: config.NODE_ENV });
  marketData.start();
});

function shutdown() { console.log('[arbscope] shutting down…'); marketData.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
module.exports = { app, server, store, marketData, trading };
