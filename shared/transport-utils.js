/**
 * Transport helpers shared by the Node proxy transport and the browser
 * fallback transport. Both speak the `fetch` API.
 */

export const DEFAULT_BACKEND_URL = 'https://backend.aether.cx';

/** Cap on a single upstream body (the Prometheus windows can be several MB). */
export const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Reads a response body as text, aborting once `maxBytes` is exceeded so a
 * runaway metric dump can never exhaust memory.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readTextCapped(response, maxBytes = DEFAULT_MAX_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw Object.assign(new Error(`Response too large (${declared} bytes > ${maxBytes} byte limit)`), { code: 'TOO_LARGE' });
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw Object.assign(new Error('Response too large'), { code: 'TOO_LARGE' });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error(`Response exceeded ${maxBytes} byte limit`), { code: 'TOO_LARGE' });
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
  return text + decoder.decode();
}

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Error classes worth a retry (network hiccups, TLS resets, DNS blips). */
export function isNetworkError(error) {
  if (!error) return false;
  const code = error.code || error.cause?.code || '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'TOO_LARGE'].includes(code)) {
    return code !== 'TOO_LARGE';
  }
  const message = String(error.message || '');
  return /fetch failed|network|socket|tls|ssl|abort|timeout/i.test(message);
}

/** @param {number} attempt 1-based */
export function backoffDelay(attempt, baseMs = 400, capMs = 6000) {
  const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * exponential * 0.25;
  return Math.round(exponential + jitter);
}

/** @param {Headers|undefined} headers */
export function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Human message for an HTTP failure, using the backend's own error envelope. */
export function describeHttpError(status, data, text) {
  const message = data?.message || data?.statusMessage;
  if (message) return `HTTP ${status} — ${message}`;
  if (typeof text === 'string' && text.trim() && text.trim().length < 200) return `HTTP ${status} — ${text.trim()}`;
  return `HTTP ${status}`;
}
