/**
 * Node-side transport for the Aether backend.
 *
 * Responsibilities beyond a plain fetch:
 *  - per-route throttle (never hammer a shared backend),
 *  - global concurrency cap,
 *  - retry with exponential backoff on 429/5xx/network hiccups,
 *  - respect `Retry-After`, then hold a cooldown so parallel callers back off too,
 *  - size cap on responses (the Prometheus windows are multi-MB),
 *  - classify network failures so callers can tell "backend answered 500" from
 *    "this host cannot reach the backend at all" (used for the fallback path).
 *
 * The Authorization header is never logged and never leaves the server.
 */

import {
  DEFAULT_MAX_BYTES,
  backoffDelay,
  describeHttpError,
  isNetworkError,
  isRetryableStatus,
  readTextCapped,
  retryAfterMs,
} from '../shared/transport-utils.js';
import { config } from './config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AetherTransport {
  /**
   * @param {{ baseUrl: string, timeoutMs?: number, maxRetries?: number, minIntervalMs?: number, maxConcurrent?: number, maxBytes?: number, logLevel?: string }} options
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.maxRetries = options.maxRetries ?? config.maxRetries;
    this.minIntervalMs = options.minIntervalMs ?? config.minIntervalMs;
    this.maxConcurrent = options.maxConcurrent ?? config.maxConcurrent;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logLevel = options.logLevel ?? config.logLevel;

    /** @type {Map<string, number>} */
    this.lastRequestAt = new Map();
    this.active = 0;
    this.cooldownUntil = 0;
    this.cooldownReason = null;
    /** @type {{ at: number, ok: boolean, status: number|null, error: string|null, networkError: boolean }|null} */
    this.lastProbe = null;
  }

  get inCooldown() {
    return Date.now() < this.cooldownUntil;
  }

  log(level, message, meta) {
    const order = { error: 0, warn: 1, info: 2, debug: 3 };
    if ((order[level] ?? 2) > (order[this.logLevel] ?? 2)) return;
    const line = `[aether] ${message}`;
    if (meta) console[level === 'debug' ? 'log' : level](line, meta);
    else console[level === 'debug' ? 'log' : level](line);
  }

  async #throttle(routeKey) {
    const last = this.lastRequestAt.get(routeKey) || 0;
    const wait = this.minIntervalMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt.set(routeKey, Date.now());
  }

  async #acquire() {
    while (this.active >= this.maxConcurrent) await sleep(25);
    this.active += 1;
  }

  #release() {
    this.active = Math.max(0, this.active - 1);
  }

  /**
   * @param {string} path e.g. "/discover"
   * @param {{ method?: string, body?: any, token?: string|null, timeoutMs?: number, accept?: string, retries?: number, raw?: boolean }} [options]
   */
  async request(path, options = {}) {
    const method = options.method || 'GET';
    const retries = options.retries ?? this.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const url = `${this.baseUrl}${path}`;
    const routeKey = `${method} ${path.split('?')[0]}`;

    let attempt = 0;
    let lastError = null;

    while (attempt <= retries) {
      if (this.inCooldown) {
        const remaining = this.cooldownUntil - Date.now();
        return {
          ok: false,
          status: 429,
          error: `Backend rate limit cooldown active (${Math.ceil(remaining / 1000)}s) — ${this.cooldownReason || 'retry later'}`,
          rateLimited: true,
          data: null,
          text: null,
          path,
          durationMs: 0,
          attempts: attempt,
        };
      }

      attempt += 1;
      const started = Date.now();
      await this.#throttle(routeKey);
      await this.#acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

      try {
        /** @type {Record<string,string>} */
        const headers = { accept: options.accept || 'application/json' };
        if (options.token) headers.authorization = `Bearer ${options.token}`;
        if (options.body !== undefined) headers['content-type'] = 'application/json';

        const response = await fetch(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
          redirect: 'follow',
        });

        const headersOut = {
          retryAfterMs: retryAfterMs(response.headers),
          contentType: response.headers.get('content-type') || '',
          cacheStatus: response.headers.get('cf-cache-status') || null,
        };

        let text = '';
        if (method !== 'HEAD') {
          try {
            text = await readTextCapped(response, this.maxBytes);
          } catch (error) {
            if (error?.code === 'TOO_LARGE') {
              text = '';
              const durationMs = Date.now() - started;
              this.log('warn', `${method} ${path} -> response exceeded size cap`, { durationMs });
              return {
                ok: false,
                status: response.status,
                error: `Response exceeded the ${Math.round(this.maxBytes / 1024 / 1024)} MB cap`,
                code: 'TOO_LARGE',
                data: null,
                text: null,
                path,
                durationMs,
                attempts: attempt,
                headers: headersOut,
              };
            }
            throw error;
          }
        }

        let data = null;
        const looksJson = headersOut.contentType.includes('json') || /^[[{]/.test(text.trim().slice(0, 1));
        if (looksJson && text.trim()) {
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        }

        const durationMs = Date.now() - started;

        if (response.ok) {
          this.log('debug', `${method} ${path} -> ${response.status}`, { durationMs, bytes: text.length });
          return { ok: true, status: response.status, data, text, path, durationMs, attempts: attempt, headers: headersOut };
        }

        const error = describeHttpError(response.status, data, text);
        const rateLimited = response.status === 429 || response.status === 503;

        if (rateLimited) {
          const waitMs = headersOut.retryAfterMs ?? 15000;
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(waitMs, 120000));
          this.cooldownReason = `HTTP ${response.status} on ${path}`;
          this.log('warn', `${method} ${path} -> ${response.status}; cooling down ${Math.round(waitMs / 1000)}s`);
        } else {
          this.log('warn', `${method} ${path} -> ${response.status}`, { durationMs, error });
        }

        if (attempt <= retries && isRetryableStatus(response.status)) {
          await sleep(headersOut.retryAfterMs ?? backoffDelay(attempt));
          continue;
        }

        return { ok: false, status: response.status, error, data, text, path, durationMs, attempts: attempt, headers: headersOut, rateLimited };
      } catch (error) {
        const durationMs = Date.now() - started;
        const networkError = isNetworkError(error);
        lastError = error;
        const message = networkError
          ? `Network unreachable from the app server: ${error?.message || error}`
          : error?.message || String(error);

        this.log('warn', `${method} ${path} -> ${networkError ? 'NETWORK ERROR' : 'ERROR'}`, { durationMs, message });

        if (attempt <= retries) {
          await sleep(backoffDelay(attempt));
          continue;
        }

        return {
          ok: false,
          status: null,
          error: message,
          networkError,
          data: null,
          text: null,
          path,
          durationMs,
          attempts: attempt,
        };
      } finally {
        clearTimeout(timer);
        this.#release();
      }
    }

    return {
      ok: false,
      status: null,
      error: lastError?.message || 'Unknown transport error',
      networkError: true,
      data: null,
      text: null,
      path,
      durationMs: 0,
      attempts: attempt,
    };
  }

  /**
   * Cheap reachability probe (GET /healthcheck). HTTP errors still count as
   * "reachable" — they mean the backend answered.
   * @param {{ force?: boolean }} [options]
   */
  async probe({ force = false } = {}) {
    const fresh = this.lastProbe && Date.now() - this.lastProbe.at < 15000;
    if (fresh && !force) return this.lastProbe;

    const result = await this.request('/healthcheck', {
      timeoutMs: config.probeTimeoutMs,
      retries: 0,
      accept: 'application/json',
    });

    this.lastProbe = {
      at: Date.now(),
      ok: result.ok,
      status: result.status ?? null,
      error: result.error ?? null,
      networkError: Boolean(result.networkError),
    };
    return this.lastProbe;
  }

  /** True when the backend is definitely unreachable from this host. */
  async serverPathUnavailable() {
    const probe = await this.probe();
    return probe.networkError === true;
  }
}

export function createTransport(baseUrl = config.backendUrl) {
  return new AetherTransport({
    baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    minIntervalMs: config.minIntervalMs,
    maxConcurrent: config.maxConcurrent,
    maxBytes: config.maxBytes,
    logLevel: config.logLevel,
  });
}
