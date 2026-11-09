'use strict';
/**
 * Central configuration. Everything env-driven, nothing secret hardcoded.
 * Secrets (exchange API keys) are NOT stored here — they live in the encrypted vault (server/vault.js).
 */
const path = require('path');
const crypto = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Master key for the credential vault. In production it MUST come from the environment.
// In development we generate an ephemeral key (data becomes unreadable across restarts — acceptable & safe).
let MASTER_KEY = process.env.ARBSCOPE_MASTER_KEY || null;
let masterKeySource = 'env';
if (!MASTER_KEY) {
  if (NODE_ENV === 'production') {
    // Fail closed: never run live/persistent in production without a master key.
    throw new Error('ARBSCOPE_MASTER_KEY environment variable is required in production. Generate one with: openssl rand -hex 32');
  }
  MASTER_KEY = crypto.randomBytes(32).toString('hex');
  masterKeySource = 'ephemeral-dev-key';
}

module.exports = {
  NODE_ENV,
  PORT: parseInt(process.env.PORT || '8787', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  MASTER_KEY,
  masterKeySource,
  // DATA_MODE: 'auto' tries live public APIs and falls back to the simulator on failure,
  // 'live' uses only real exchange APIs (fails visibly), 'simulated' uses the built-in simulator.
  DATA_MODE: (process.env.DATA_MODE || 'auto').toLowerCase(),
  // Polling cadence for market data (ms). Exchange rate limits are respected by per-venue pacing.
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),
  // A quote/book older than this is considered stale and CANNOT be used for order submission.
  STALE_AFTER_MS: parseInt(process.env.STALE_AFTER_MS || '10000', 10),
  // Fetch timeout for outbound exchange API calls (ms).
  FETCH_TIMEOUT_MS: parseInt(process.env.FETCH_TIMEOUT_MS || '6000', 10),
  // Preview (confirmation ticket) time-to-live before it expires (ms).
  PREVIEW_TTL_MS: 60_000,
  // Audit log ring size persisted to disk.
  AUDIT_LOG_LIMIT: 1000,
};
