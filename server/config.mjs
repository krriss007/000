import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BACKEND_URL, DEFAULT_WINDOWS, ALL_WINDOWS } from '../shared/sources.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');

function parseWindows(raw) {
  const requested = String(raw || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => ALL_WINDOWS.includes(value));
  return requested.length ? [...new Set(requested)] : DEFAULT_WINDOWS;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),

  /** Backend under test — configurable, defaults to the public Aether backend. */
  backendUrl: (process.env.AETHER_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/+$/, ''),
  backendUrlConfigured: Boolean(process.env.AETHER_BACKEND_URL),

  /** Account credentials: never sent to the browser, never logged. */
  mnemonic: (process.env.AETHER_MNEMONIC || '').trim() || null,
  sessionToken: (process.env.AETHER_SESSION_TOKEN || '').trim() || null,
  deviceName: (process.env.AETHER_DEVICE_NAME || 'Aether Catalog (server)').slice(0, 200),
  namespace: (process.env.AETHER_NAMESPACE || '').trim() || 'aether.cx',
  captchaToken: (process.env.AETHER_CAPTCHA_TOKEN || '').trim() || null,

  dataDir: process.env.AETHER_DATA_DIR ? path.resolve(ROOT_DIR, process.env.AETHER_DATA_DIR) : path.join(ROOT_DIR, 'data'),
  sessionFile: path.join(process.env.AETHER_DATA_DIR ? path.resolve(ROOT_DIR, process.env.AETHER_DATA_DIR) : path.join(ROOT_DIR, 'data'), 'session.json'),

  /** Networking behaviour towards the backend. */
  timeoutMs: Number(process.env.AETHER_TIMEOUT_MS || 20000),
  probeTimeoutMs: Number(process.env.AETHER_PROBE_TIMEOUT_MS || 7000),
  maxRetries: Number(process.env.AETHER_MAX_RETRIES || 2),
  minIntervalMs: Number(process.env.AETHER_MIN_INTERVAL_MS || 250),
  maxConcurrent: Number(process.env.AETHER_MAX_CONCURRENT || 4),
  maxBytes: Number(process.env.AETHER_MAX_BYTES || 12 * 1024 * 1024),
  metricsWindows: parseWindows(process.env.AETHER_METRICS_WINDOWS),

  /** Dev/test switch: pretend this host cannot reach the backend, so the
   *  browser fallback path can be exercised (see tools/dom-test.mjs). */
  forceDirect: process.env.AETHER_FORCE_DIRECT === '1',

  webDist: path.join(ROOT_DIR, 'web-dist'),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  isProduction: process.env.NODE_ENV === 'production',
};

export { ALL_WINDOWS, DEFAULT_WINDOWS };
