/**
 * Browser transport — used only on the fallback "direct" data path, when the
 * application server cannot reach the Aether backend from its own network.
 *
 * It hits the same public GET endpoints the server would have proxied, with the
 * same retry/backoff/cooldown behaviour. The backend's CORS policy is
 * `access-control-allow-origin: *` (observed live), so no proxy is required.
 * Account endpoints are never called from here: credentials are server-only.
 */

import {
  DEFAULT_MAX_BYTES,
  backoffDelay,
  describeHttpError,
  isNetworkError,
  isRetryableStatus,
  readTextCapped,
  retryAfterMs,
} from '@shared/transport-utils.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TransportResult {
  ok: boolean;
  status: number | null;
  data: any;
  text: string | null;
  path: string;
  error: string | null;
  networkError?: boolean;
  rateLimited?: boolean;
  durationMs: number;
  attempts: number;
}

let cooldownUntil = 0;
let cooldownReason: string | null = null;

export function transportCooldown() {
  return { active: Date.now() < cooldownUntil, until: cooldownUntil, reason: cooldownReason };
}

export function createBrowserTransport({ baseUrl, timeoutMs = 20000, maxRetries = 2 }: { baseUrl: string; timeoutMs?: number; maxRetries?: number }) {
  const root = baseUrl.replace(/\/+$/, '');

  return async function transport(
    path: string,
    options: { method?: string; timeoutMs?: number; accept?: string; retries?: number } = {}
  ): Promise<TransportResult> {
    const method = options.method || 'GET';
    const retries = options.retries ?? maxRetries;
    const timeout = options.timeoutMs ?? timeoutMs;
    let attempt = 0;

    if (Date.now() < cooldownUntil) {
      return {
        ok: false,
        status: 429,
        data: null,
        text: null,
        path,
        rateLimited: true,
        error: `Backend asked us to slow down — retry in ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s${cooldownReason ? ` (${cooldownReason})` : ''}`,
        durationMs: 0,
        attempts: 0,
      };
    }

    while (attempt <= retries) {
      attempt += 1;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);

      try {
        const response = await fetch(`${root}${path}`, {
          method,
          headers: { accept: options.accept || 'application/json' },
          signal: controller.signal,
          credentials: 'omit',
          mode: 'cors',
          referrerPolicy: 'no-referrer',
        });

        const after = retryAfterMs(response.headers);
        const contentType = response.headers.get('content-type') || '';
        const text = method === 'HEAD' ? '' : await readTextCapped(response, DEFAULT_MAX_BYTES);
        let data: any = null;
        if (text.trim() && (contentType.includes('json') || /^[[{]/.test(text.trim().slice(0, 1)))) {
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        }

        if (response.ok) {
          return { ok: true, status: response.status, data, text, path, error: null, durationMs: Date.now() - started, attempts: attempt };
        }

        if (response.status === 429 || response.status === 503) {
          const wait = after ?? 15000;
          cooldownUntil = Date.now() + Math.min(wait, 120000);
          cooldownReason = `HTTP ${response.status} on ${path}`;
        }

        if (attempt <= retries && isRetryableStatus(response.status)) {
          await sleep(after ?? backoffDelay(attempt));
          continue;
        }

        return {
          ok: false,
          status: response.status,
          data,
          text,
          path,
          error: describeHttpError(response.status, data, text),
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (error: any) {
        const networkError = isNetworkError(error);
        const message = networkError
          ? `Request blocked or unreachable from this browser: ${error?.message || error}`
          : error?.message || String(error);
        if (attempt <= retries) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        return {
          ok: false,
          status: null,
          data: null,
          text: null,
          path,
          error: message,
          networkError,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return { ok: false, status: null, data: null, text: null, path, error: 'Unknown transport error', networkError: true, durationMs: 0, attempts: attempt };
  };
}
