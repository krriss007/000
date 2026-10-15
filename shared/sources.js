/**
 * The single implementation of "read the Aether backend".
 *
 * Both data paths call into this module:
 *   - server path (default): `server/transport.mjs` fetches upstream, so the
 *     backend URL and any account credentials stay on the server;
 *   - direct path (fallback, used when the app server cannot reach the backend,
 *     e.g. inside a restricted sandbox network): the browser transports the same
 *     requests against the same public endpoints. CORS on the Aether backend is
 *     `access-control-allow-origin: *` (verified), so this works without a proxy.
 *
 * Keeping one loader guarantees identical rows/models on both paths.
 */

import { createCache } from './cache.js';
import {
  buildTitleIndex,
  dedupeRow,
  enrichItems,
  fromBookmarks,
  fromDiscover,
  fromLetterboxd,
  fromMetrics,
  fromProgress,
  fromPublicList,
  fromRatings,
  fromUserLists,
  fromWatchHistory,
} from './normalize.js';
import { parsePrometheus } from './prometheus.js';
import { DEFAULT_BACKEND_URL } from './transport-utils.js';

export { DEFAULT_BACKEND_URL };

export const DEFAULT_TTLS = {
  discover: 300,
  metrics: 180,
  letterboxd: 900,
  meta: 600,
  healthcheck: 45,
  list: 300,
  account: 45,
};

/**
 * The Prometheus windows differ wildly in size (`/metrics/weekly` is several MB,
 * `/metrics/monthly` more), so each gets its own TTL: the bigger the payload,
 * the longer it stays cached. Keeps the app a polite client of a shared backend.
 */
export const METRICS_WINDOW_TTL = {
  daily: 180,
  weekly: 900,
  monthly: 3600,
};

export const DEFAULT_WINDOWS = ['daily', 'weekly'];
export const ALL_WINDOWS = ['daily', 'weekly', 'monthly'];

export const ENDPOINT_NOTES = {
  '/discover': 'Aggregated TMDB + Trakt catalog. Aggressive caching is expected upstream.',
  '/letterboxd': 'Scrapes Letterboxd public lists and matches them against TMDB.',
  '/metrics/daily': 'Public Prometheus counters written by the official apps.',
  '/users/@me': 'Requires Authorization: Bearer <session>. Own account only.',
  '/lists/:id': 'Public lists only; private lists answer 403.',
};

/** @param {{ url: string, ok: boolean, status: number|null, error?: string|null, fetchedAt: string, cached: boolean, ttlSeconds: number, itemCount?: number, note?: string }} source */
function sourceStatus(source) {
  return {
    endpoint: source.url,
    ok: source.ok,
    status: source.status,
    error: source.error || null,
    fetchedAt: source.fetchedAt,
    cached: source.cached,
    ttlSeconds: source.ttlSeconds,
    itemCount: source.itemCount ?? null,
    note: source.note || ENDPOINT_NOTES[source.url] || null,
  };
}

/**
 * @param {{
 *   backendUrl?: string,
 *   transport: (path: string, options?: any) => Promise<any>,
 *   cache?: ReturnType<typeof createCache>,
 *   ttls?: Partial<typeof DEFAULT_TTLS>,
 *   windows?: string[],
 * }} options
 */
export function createAetherData(options) {
  const backendUrl = (options.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  const transport = options.transport;
  const cache = options.cache || createCache({ maxEntries: 64 });
  const ttls = { ...DEFAULT_TTLS, ...(options.ttls || {}) };

  /** Short TTL for failed upstream calls: keep the failure visible, but let a
   * manual refresh retry quickly instead of waiting out the full TTL. */
  const FAILURE_TTL_SECONDS = 25;

  /** Run a JSON GET through the cache. */
  async function cachedJson(path, ttlSeconds, { force = false, token = null, timeoutMs } = {}) {
    const key = `${token ? 'auth' : 'anon'}:${path}`;
    const entry = await cache.load(
      key,
      ttlSeconds * 1000,
      () => transport(path, { token, timeoutMs }),
      { force }
    );
    if (entry.value?.ok === false) cache.set(key, entry.value, Math.min(ttlSeconds, FAILURE_TTL_SECONDS) * 1000);
    return entry;
  }

  async function cachedText(path, ttlSeconds, { force = false, timeoutMs } = {}) {
    const key = `anon:${path}`;
    const entry = await cache.load(
      key,
      ttlSeconds * 1000,
      () => transport(path, { timeoutMs, accept: 'text/plain' }),
      { force }
    );
    if (entry.value?.ok === false) cache.set(key, entry.value, Math.min(ttlSeconds, FAILURE_TTL_SECONDS) * 1000);
    return entry;
  }

  function statusFrom(entry, result, extra = {}) {
    return sourceStatus({
      url: extra.url || result?.path || '',
      ok: result?.ok === true,
      status: result?.status ?? null,
      error: result?.error ?? null,
      fetchedAt: entry.fetchedAt,
      cached: entry.cached,
      ttlSeconds: entry.ttlSeconds,
      itemCount: extra.itemCount,
      note: extra.note,
    });
  }

  /* ---------------- individual sources ---------------- */

  async function loadMeta({ force = false } = {}) {
    const entry = await cachedJson('/meta', ttls.meta, { force, timeoutMs: 8000 });
    return { result: entry.value, entry, source: statusFrom(entry, entry.value, { url: '/meta' }) };
  }

  async function loadHealthcheck({ force = false } = {}) {
    const entry = await cachedJson('/healthcheck', ttls.healthcheck, { force, timeoutMs: 8000 });
    return { result: entry.value, entry, source: statusFrom(entry, entry.value, { url: '/healthcheck' }) };
  }

  async function loadDiscover({ force = false } = {}) {
    const entry = await cachedJson('/discover', ttls.discover, { force, timeoutMs: 25000 });
    const result = entry.value;
    const parsed = result?.ok ? fromDiscover(result.data) : { rows: [], rowsMeta: [], genres: { movies: [], shows: [] }, itemCount: 0 };
    return {
      result,
      entry,
      parsed,
      source: statusFrom(entry, result, {
        url: '/discover',
        itemCount: parsed.itemCount,
        note: result?.ok
          ? ENDPOINT_NOTES['/discover']
          : 'The deployment answers 500 here: its TMDB/Trakt credentials or upstream calls are failing (see docs/BACKEND.md).',
      }),
    };
  }

  async function loadMetricsWindow(window, { force = false } = {}) {
    const path = `/metrics/${window}`;
    const ttl = METRICS_WINDOW_TTL[window] ?? ttls.metrics;
    const entry = await cachedText(path, ttl, { force, timeoutMs: 25000 });
    const result = entry.value;
    const parsed = result?.ok ? parsePrometheus(result.text || '') : null;
    return {
      result,
      entry,
      parsed,
      source: sourceStatus({
        url: path,
        ok: result?.ok === true,
        status: result?.status ?? null,
        error: result?.error ?? null,
        fetchedAt: entry.fetchedAt,
        cached: entry.cached,
        ttlSeconds: entry.ttlSeconds,
        itemCount: parsed ? parsed.samples.length : 0,
        note: parsed ? `${parsed.names.length} metric families` : ENDPOINT_NOTES[path],
      }),
    };
  }

  async function loadMetrics({ windows = options.windows || DEFAULT_WINDOWS, force = false } = {}) {
    const results = await Promise.all(windows.map((window) => loadMetricsWindow(window, { force })));
    /** @type {Record<string, any>} */
    const parsedByWindow = {};
    const sources = [];
    for (const item of results) {
      const window = item.source.endpoint.split('/').pop();
      if (item.parsed) parsedByWindow[window] = item.parsed;
      sources.push(item.source);
    }
    const parsed = results.find((r) => r.parsed)?.parsed || { samples: [], byName: new Map(), names: [] };
    return { parsedByWindow, sources, normalized: fromMetrics(parsedByWindow, windows) };
  }

  async function loadLetterboxd({ force = false } = {}) {
    const entry = await cachedJson('/letterboxd', ttls.letterboxd, { force, timeoutMs: 25000 });
    const result = entry.value;
    const parsed = result?.ok ? fromLetterboxd(result.data) : { rows: [], rowsMeta: [], note: null };
    return {
      result,
      entry,
      parsed,
      source: statusFrom(entry, result, {
        url: '/letterboxd',
        itemCount: parsed.rows.reduce((sum, row) => sum + row.length, 0),
        note: result?.ok
          ? parsed.note
            ? `Backend answered: "${parsed.note}"`
            : ENDPOINT_NOTES['/letterboxd']
          : 'Scraper failed upstream.',
      }),
    };
  }

  async function loadPublicList(id, { force = false } = {}) {
    const path = `/lists/${encodeURIComponent(id)}`;
    const entry = await cachedJson(path, ttls.list, { force, timeoutMs: 12000 });
    const result = entry.value;
    const list = result?.ok ? fromPublicList(result.data) : null;
    return {
      result,
      entry,
      list,
      source: sourceStatus({
        url: '/lists/:id',
        ok: Boolean(list),
        status: result?.status ?? null,
        error: list ? null : result?.error || 'No public list with that id',
        fetchedAt: entry.fetchedAt,
        cached: entry.cached,
        ttlSeconds: entry.ttlSeconds,
        itemCount: list ? list.items.length : 0,
        note: ENDPOINT_NOTES['/lists/:id'],
      }),
    };
  }

  /* ---------------- composed catalog ---------------- */

  /**
   * @param {{ force?: boolean, windows?: string[] }} [opts]
   */
  async function loadCatalog({ force = false, windows = options.windows || DEFAULT_WINDOWS } = {}) {
    const [discover, metrics, letterboxd] = await Promise.all([
      loadDiscover({ force }),
      loadMetrics({ windows, force }),
      loadLetterboxd({ force }),
    ]);

    const sources = [discover.source, ...metrics.sources, letterboxd.source];

    const discoverRows = discover.parsed.rows.map((items, index) => ({
      ...discover.parsed.rowsMeta[index],
      items: dedupeRow(items),
      fetchedAt: discover.entry.fetchedAt,
      cached: discover.entry.cached,
      sourceOk: true,
    }));
    const metricsRows = metrics.normalized.rows.map((items, index) => ({
      ...metrics.normalized.rowsMeta[index],
      items: dedupeRow(items),
      fetchedAt: sources.find((s) => s.endpoint === metrics.normalized.rowsMeta[index].endpoint)?.fetchedAt || new Date().toISOString(),
      cached: sources.find((s) => s.endpoint === metrics.normalized.rowsMeta[index].endpoint)?.cached ?? false,
      sourceOk: true,
    }));
    const letterboxdRows = letterboxd.parsed.rows.map((items, index) => ({
      ...letterboxd.parsed.rowsMeta[index],
      items: dedupeRow(items),
      fetchedAt: letterboxd.entry.fetchedAt,
      cached: letterboxd.entry.cached,
      sourceOk: true,
    }));

    const ordered = discover.source.ok
      ? [...discoverRows, ...metricsRows, ...letterboxdRows]
      : [...metricsRows, ...letterboxdRows, ...discoverRows];

    // Enrichment pass: give id-only records a real title/artwork when the same
    // TMDB id appeared with full metadata elsewhere in the payloads.
    const index = buildTitleIndex([...discoverRows, ...metricsRows, ...letterboxdRows].flatMap((row) => row.items));
    const rows = ordered.map((row) => ({ ...row, items: enrichItems(row.items, index) }));

    const featured = pickFeatured(rows);

    return {
      ok: rows.some((row) => row.items.length > 0),
      dataPath: options.dataPath || 'server',
      backendUrl,
      generatedAt: new Date().toISOString(),
      windows,
      sources,
      rows: rows.filter((row) => row.items.length > 0),
      featured,
      genres: discover.parsed.genres,
      trending: metrics.normalized.trendingByWindow,
      providers: metrics.normalized.providersByWindow,
      metricsSummary: summarizeMetrics(metrics.parsedByWindow, windows),
      discoverNote: discover.source.ok ? null : discover.source.error,
    };
  }

  /* ---------------- account library ---------------- */

  async function loadLibrary({ token, userId, catalogRows = [], force = false } = {}) {
    if (!token || !userId) {
      return { signedIn: false, rows: [], sources: [], user: null, generatedAt: new Date().toISOString() };
    }

    const paths = {
      me: '/users/@me',
      settings: `/users/${userId}/settings`,
      bookmarks: `/users/${userId}/bookmarks`,
      progress: `/users/${userId}/progress`,
      history: `/users/${userId}/watch-history`,
      ratings: `/users/${userId}/ratings`,
      lists: `/users/${userId}/lists`,
      sessions: `/users/${userId}/sessions`,
    };

    const entries = await Promise.all(
      Object.entries(paths).map(async ([name, path]) => {
        const entry = await cachedJson(path, ttls.account, { force, token, timeoutMs: 15000 });
        return [name, path, entry];
      })
    );

    /** @type {Record<string, any>} */
    const values = {};
    const sources = [];
    for (const [name, path, entry] of entries) {
      const result = entry.value;
      values[name] = result?.ok ? result.data : null;
      sources.push(
        sourceStatus({
          url: path.startsWith('/users/') && path !== '/users/@me' ? path.replace(userId, ':id') : path,
          ok: result?.ok === true,
          status: result?.status ?? null,
          error: result?.error ?? null,
          fetchedAt: entry.fetchedAt,
          cached: entry.cached,
          ttlSeconds: entry.ttlSeconds,
          itemCount: Array.isArray(result?.data) ? result.data.length : null,
        })
      );
    }

    const progress = fromProgress(values.progress);
    const history = fromWatchHistory(values.history);
    const bookmarks = fromBookmarks(values.bookmarks);
    const ratings = fromRatings(values.ratings);
    const userLists = fromUserLists(values.lists);

    const index = buildTitleIndex([catalogRows.flatMap((row) => row.items), bookmarks, progress, history]);
    const enrich = (items) => enrichItems(items, index);

    const rows = [];
    const push = (meta, items) => {
      const clean = enrich(dedupeRow(items || []));
      if (!clean.length) return;
      const source = sources.find((s) => meta.endpoint && s.endpoint === meta.endpoint);
      rows.push({
        ...meta,
        items: clean,
        fetchedAt: source?.fetchedAt || new Date().toISOString(),
        cached: source?.cached ?? false,
        sourceOk: source ? source.ok : true,
      });
    };

    push(
      { id: 'library-continue', title: 'Continue Watching', subtitle: 'Saved playback progress', endpoint: '/users/:id/progress' },
      progress
    );
    push(
      { id: 'library-bookmarks', title: 'My List', subtitle: 'Bookmarked titles', endpoint: '/users/:id/bookmarks' },
      bookmarks
    );
    push(
      { id: 'library-history', title: 'Watch History', subtitle: 'Most recently watched first', endpoint: '/users/:id/watch-history' },
      history
    );
    push({ id: 'library-ratings', title: 'Your Ratings', subtitle: 'Highest first', endpoint: '/users/:id/ratings' }, ratings);

    for (const list of userLists) {
      push(
        {
          id: `library-list-${list.id}`,
          title: list.name,
          subtitle: `${list.isPublic ? 'Public' : 'Private'} list · ${list.items.length} items · /users/:id/lists`,
          endpoint: '/users/:id/lists',
        },
        list.items
      );
    }

    return {
      signedIn: Boolean(values.me?.user),
      user: values.me?.user || null,
      session: values.me?.session || null,
      settings: values.settings || null,
      sessions: Array.isArray(values.sessions) ? values.sessions : [],
      lists: userLists,
      counts: {
        progress: progress.length,
        bookmarks: bookmarks.length,
        history: history.length,
        ratings: ratings.length,
        lists: userLists.length,
      },
      rows,
      sources,
      generatedAt: new Date().toISOString(),
    };
  }

  /* ---------------- status / overview ---------------- */

  async function loadOverview({ force = false, windows = options.windows || DEFAULT_WINDOWS } = {}) {
    const [meta, healthcheck, metrics] = await Promise.all([
      loadMeta({ force }),
      loadHealthcheck({ force }),
      loadMetrics({ windows, force }),
    ]);

    const networkError = [meta, healthcheck].some((item) => item.source.status === null && item.source.error);
    const reachable = [meta.result, healthcheck.result].some((result) => result?.ok === true);

    return {
      backendUrl,
      reachable,
      checkedAt: new Date().toISOString(),
      meta: meta.result?.ok ? meta.result.data : null,
      healthcheck: healthcheck.result?.ok ? healthcheck.result.data : null,
      rootMessage: null,
      sources: [meta.source, healthcheck.source, ...metrics.sources],
      providers: metrics.normalized.providersByWindow,
      trending: metrics.normalized.trendingByWindow,
      metricsSummary: summarizeMetrics(metrics.parsedByWindow, windows),
      networkError,
      cache: cache.snapshot(),
    };
  }

  return {
    backendUrl,
    cache,
    loadMeta,
    loadHealthcheck,
    loadMetrics,
    loadMetricsWindow,
    loadDiscover,
    loadLetterboxd,
    loadPublicList,
    loadCatalog,
    loadLibrary,
    loadOverview,
  };
}

/** Featured hero: prefer something with artwork + a synopsis, else anything. */
function pickFeatured(rows) {
  const preferredRowIds = ['discover-popular-movies', 'discover-now-playing', 'discover-trending', 'metrics-trending-daily', 'metrics-trending-weekly'];
  const candidates = [];
  for (const rowId of preferredRowIds) {
    const row = rows.find((r) => r.id === rowId);
    if (row) candidates.push(...row.items.map((item) => ({ item, row })));
  }
  if (!candidates.length) {
    for (const row of rows) candidates.push(...row.items.map((item) => ({ item, row })));
  }
  const best =
    candidates.find((c) => c.item.backdropPath && (c.item.overview || c.item.rating)) ||
    candidates.find((c) => c.item.backdropPath) ||
    candidates.find((c) => c.item.posterPath && c.item.rating) ||
    candidates.find((c) => c.item.overview) ||
    candidates[0];
  if (!best) return null;
  return {
    ...best.item,
    featuredFrom: { rowId: best.row.id, rowTitle: best.row.title, endpoint: best.row.endpoint, fetchedAt: best.row.fetchedAt },
  };
}

function summarizeMetrics(parsedByWindow, windows) {
  /** @type {Record<string, any>} */
  const summary = {};
  for (const window of windows) {
    const parsed = parsedByWindow[window];
    if (!parsed) continue;
    const providerStatus = parsed.byName.get(`mw_provider_status_count_${window}`) || [];
    const hostnames = parsed.byName.get(`mw_provider_hostname_count_${window}`) || [];
    const users = parsed.byName.get(`mw_user_count_${window}`) || [];
    const captcha = parsed.byName.get(`mw_captcha_solves_${window}`) || [];
    summary[window] = {
      samples: parsed.samples.length,
      metricFamilies: parsed.names.length,
      plays: providerStatus.reduce((sum, sample) => sum + sample.value, 0),
      hostnames: hostnames.reduce((sum, sample) => sum + sample.value, 0),
      users: users.reduce((sum, sample) => sum + sample.value, 0),
      captcha: captcha.reduce((sum, sample) => sum + sample.value, 0),
      topTitles: (parsed.byName.get(`mw_media_watch_count_${window}`) || []).filter((s) => s.labels.success === 'true').length,
    };
  }
  return summary;
}
