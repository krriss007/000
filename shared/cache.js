/**
 * TTL cache with in-flight coalescing. Runs in Node and in the browser, so the
 * server proxy and the direct-browser fallback behave identically:
 *  - one upstream request per key at a time (no stampede on the Aether backend),
 *  - every result carries `fetchedAt` + `cached` so the UI can say when data
 *    was last fetched,
 *  - `force` bypasses a fresh entry but still joins an in-flight load.
 */

/** @typedef {{ value: any, fetchedAt: number, ttlMs: number }} CacheEntry */

export function createCache({ maxEntries = 64 } = {}) {
  /** @type {Map<string, CacheEntry>} */
  const store = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  function prune() {
    if (store.size <= maxEntries) return;
    const oldest = [...store.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of oldest.slice(0, store.size - maxEntries)) store.delete(key);
  }

  /**
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} loader
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ value: T, fetchedAt: string, cached: boolean, ageMs: number, ttlSeconds: number }>}
   */
  async function load(key, ttlMs, loader, options = {}) {
    const now = Date.now();
    const existing = store.get(key);

    if (!options.force && existing && now - existing.fetchedAt < existing.ttlMs) {
      return {
        value: existing.value,
        fetchedAt: new Date(existing.fetchedAt).toISOString(),
        cached: true,
        ageMs: now - existing.fetchedAt,
        ttlSeconds: Math.round(existing.ttlMs / 1000),
      };
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const value = await loader();
          store.set(key, { value, fetchedAt: Date.now(), ttlMs });
          prune();
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
    }

    const value = await pending;
    const entry = store.get(key);
    const fetchedAt = entry?.fetchedAt ?? Date.now();
    return {
      value,
      fetchedAt: new Date(fetchedAt).toISOString(),
      cached: Boolean(existing && !options.force && value === existing.value),
      ageMs: Date.now() - fetchedAt,
      ttlSeconds: Math.round(ttlMs / 1000),
    };
  }

  /**
   * Store a value directly. Used to shorten the TTL of a failed upstream call
   * (so a broken endpoint is not hammered) while still letting a manual refresh
   * retry soon.
   */
  function set(key, value, ttlMs) {
    store.set(key, { value, fetchedAt: Date.now(), ttlMs });
    prune();
  }

  /** Read without triggering a load. */
  function peek(key) {
    const entry = store.get(key);
    if (!entry) return null;
    return { value: entry.value, fetchedAt: new Date(entry.fetchedAt).toISOString(), ageMs: Date.now() - entry.fetchedAt };
  }

  function invalidate(prefix) {
    for (const key of [...store.keys()]) {
      if (!prefix || key.startsWith(prefix)) store.delete(key);
    }
  }

  function snapshot() {
    return [...store.entries()].map(([key, entry]) => ({
      key,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      ageMs: Date.now() - entry.fetchedAt,
      ttlSeconds: Math.round(entry.ttlMs / 1000),
      stale: Date.now() - entry.fetchedAt >= entry.ttlMs,
    }));
  }

  return { load, set, peek, invalidate, snapshot, get size() { return store.size; } };
}
