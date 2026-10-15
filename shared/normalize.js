/**
 * Normalisation layer: Aether backend payloads -> app models.
 *
 * Imported by BOTH the Node server (`server/*.mjs`, the default data path) and
 * the browser bundle (`web/src/*`, the fallback direct path), so the UI renders
 * identical structures no matter who talks to the backend.
 *
 * Nothing here invents data: every field maps 1:1 onto something the backend
 * actually returned. When the backend only exposes an id (e.g. `list_items` or
 * `ratings`), items are flagged `idOnly` and the UI renders them as such.
 */

import {
  MEDIA_WATCH_METRICS,
  PROVIDER_STATUS_METRICS,
  aggregateProviders,
  aggregateWatchedTitles,
} from './prometheus.js';

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** TMDB hosts artwork; the backend only returns paths. */
export function imageUrl(path, size = 'w342') {
  if (!path) return null;
  const value = String(path);
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith('/')) return `${TMDB_IMAGE_BASE}/${size}/${value}`;
  return `${TMDB_IMAGE_BASE}/${size}${value}`;
}

export function posterUrl(item, size = 'w342') {
  return imageUrl(item?.posterPath || item?.poster_path, size);
}

export function backdropUrl(item, size = 'w1280') {
  return imageUrl(item?.backdropPath || item?.backdrop_path, size);
}

const asString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function yearOf(value) {
  const str = asString(value);
  if (!str) return null;
  const match = /^(\d{4})/.exec(str);
  return match ? Number(match[1]) : null;
}

function normalizeType(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'movie' || raw === 'film') return 'movie';
  if (raw === 'show' || raw === 'tv' || raw === 'series') return 'show';
  return 'unknown';
}

export function titleId(type, tmdbId) {
  return `tmdb:${normalizeType(type)}:${tmdbId}`;
}

/** Stable dedupe/enrichment key. */
export function itemKey(item) {
  if (!item) return null;
  if (item.tmdbId) return `${item.type || 'unknown'}:${item.tmdbId}`;
  return item.id || null;
}

/**
 * @typedef {Object} TitleItem
 * @property {string} id
 * @property {string|null} tmdbId
 * @property {'movie'|'show'|'unknown'} type
 * @property {string|null} title
 * @property {number|null} year
 * @property {string|null} overview
 * @property {string|null} posterPath
 * @property {string|null} backdropPath
 * @property {number|null} rating         TMDB vote average (0-10)
 * @property {number|null} votes
 * @property {number[]} genreIds
 * @property {number|null} popularity
 * @property {string|null} releaseDate
 * @property {Record<string, any>} [facts]   extra numbers the source provided
 * @property {string} [origin]               endpoint the record came from
 * @property {boolean} [idOnly]              backend exposed no title/artwork
 * @property {any} [userState]               per-user rating / progress / bookmark info
 * @property {string|null} [episodeLabel]    e.g. "S2E4"
 */

/** TMDB object -> TitleItem. */
export function fromTmdb(raw, typeHint, origin = '/discover') {
  if (!raw || typeof raw !== 'object') return null;
  const type = normalizeType(typeHint || raw.media_type || (raw.first_air_date ? 'show' : 'movie'));
  const id = raw.id ?? raw.tmdb_id ?? raw.tmdbId;
  if (id === undefined || id === null) return null;
  const title = asString(raw.title) || asString(raw.name) || asString(raw.original_title) || asString(raw.original_name);
  return {
    id: titleId(type, String(id)),
    tmdbId: String(id),
    type,
    title,
    year: yearOf(raw.release_date) ?? yearOf(raw.first_air_date),
    overview: asString(raw.overview),
    posterPath: asString(raw.poster_path),
    backdropPath: asString(raw.backdrop_path),
    rating: asNumber(raw.vote_average),
    votes: asNumber(raw.vote_count),
    genreIds: Array.isArray(raw.genre_ids) ? raw.genre_ids.filter((n) => typeof n === 'number') : [],
    popularity: asNumber(raw.popularity),
    releaseDate: asString(raw.release_date) || asString(raw.first_air_date),
    origin,
  };
}

/** Trakt entry ({ movie | show, watchers | watcher_count | revenue, ... }) -> TitleItem. */
export function fromTrakt(entry, origin = '/discover') {
  if (!entry || typeof entry !== 'object') return null;
  const media = entry.movie || entry.show;
  if (!media) return null;
  const type = entry.movie ? 'movie' : 'show';
  const tmdbId = media.ids?.tmdb ?? media.ids?.tmdb_id ?? null;
  const id = tmdbId != null ? String(tmdbId) : asString(media.ids?.slug);

  /** @type {Record<string, any>} */
  const facts = {};
  if (typeof entry.watchers === 'number') facts.watchers = entry.watchers;
  if (typeof entry.watcher_count === 'number') facts.watchers = entry.watcher_count;
  if (typeof entry.play_count === 'number') facts.plays = entry.play_count;
  if (typeof entry.collected_count === 'number') facts.collected = entry.collected_count;
  if (typeof entry.revenue === 'number') facts.revenue = entry.revenue;
  if (typeof entry.rating === 'number') facts.traktRating = entry.rating;
  if (typeof entry.votes === 'number') facts.traktVotes = entry.votes;

  return {
    id: tmdbId != null ? titleId(type, String(tmdbId)) : `trakt:${type}:${id}`,
    tmdbId: tmdbId != null ? String(tmdbId) : null,
    type,
    title: asString(media.title) || asString(media.name),
    year: asNumber(media.year) ?? yearOf(media.released) ?? yearOf(media.first_aired),
    overview: asString(media.overview),
    posterPath: null,
    backdropPath: null,
    rating: asNumber(media.rating) ?? null,
    votes: asNumber(media.votes) ?? null,
    genreIds: [],
    popularity: null,
    releaseDate: asString(media.released) || null,
    facts,
    origin,
    idOnly: !asString(media.title) && !asString(media.name),
  };
}

/** Records the backend only knows by TMDB id (list_items, ratings, list entries). */
export function fromIdOnly(tmdbId, type, extra = {}) {
  const id = String(tmdbId ?? '');
  if (!id) return null;
  const normalized = normalizeType(type);
  return {
    id: titleId(normalized, id),
    tmdbId: id,
    type: normalized,
    title: null,
    year: null,
    overview: null,
    posterPath: null,
    backdropPath: null,
    rating: null,
    votes: null,
    genreIds: [],
    popularity: null,
    releaseDate: null,
    idOnly: true,
    ...extra,
  };
}

/** `meta` blobs stored by the official client on bookmarks/progress/watch-history. */
export function fromStoredMeta(tmdbId, meta, extra = {}) {
  const raw = meta && typeof meta === 'object' ? meta : {};
  const type = normalizeType(raw.type);
  const poster = asString(raw.poster);
  return {
    id: titleId(type, String(tmdbId ?? raw.tmdbId ?? '')),
    tmdbId: tmdbId != null ? String(tmdbId) : raw.tmdbId != null ? String(raw.tmdbId) : null,
    type,
    title: asString(raw.title),
    year: asNumber(raw.year),
    overview: null,
    posterPath: poster,
    backdropPath: null,
    rating: null,
    votes: null,
    genreIds: [],
    popularity: null,
    releaseDate: null,
    idOnly: !asString(raw.title),
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Catalog: GET /discover                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {any} payload raw `/discover` body
 * @returns {{ rows: TitleItem[][], rowsMeta: any[], genres: { movies: any[], shows: any[] }, itemCount: number }}
 */
export function fromDiscover(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const rows = [];
  const rowsMeta = [];

  const push = (meta, items) => {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return;
    rows.push(clean);
    rowsMeta.push(meta);
  };

  const tmdbList = (raw, type, transform = (x) => x) => {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
    return list.map((entry) => fromTmdb(transform(entry), type)).filter(Boolean);
  };

  push(
    { id: 'discover-now-playing', title: 'In Cinemas', subtitle: 'Now playing · TMDB /discover', endpoint: '/discover' },
    tmdbList(data.nowPlaying?.movies, 'movie')
  );
  push(
    { id: 'discover-on-the-air', title: 'On The Air', subtitle: 'Airing now · TMDB /discover', endpoint: '/discover' },
    tmdbList(data.nowPlaying?.shows, 'show')
  );
  push(
    { id: 'discover-trending', title: 'Trending Now', subtitle: 'Trakt popular movies · /discover', endpoint: '/discover' },
    (Array.isArray(data.trending) ? data.trending : []).map((entry) => fromTrakt(entry)).filter(Boolean)
  );
  push(
    { id: 'discover-most-watched', title: 'Most Watched', subtitle: 'Trakt watcher counts · /discover', endpoint: '/discover' },
    (Array.isArray(data.mostWatched) ? data.mostWatched : []).map((entry) => fromTrakt(entry)).filter(Boolean)
  );
  push(
    { id: 'discover-boxoffice', title: 'Box Office · Last Weekend', subtitle: 'Trakt revenue · /discover', endpoint: '/discover' },
    (Array.isArray(data.lastWeekend) ? data.lastWeekend : []).map((entry) => fromTrakt(entry)).filter(Boolean)
  );
  push(
    { id: 'discover-popular-movies', title: 'Popular Movies', subtitle: 'TMDB · sorted by rating · /discover', endpoint: '/discover' },
    tmdbList(data.popular?.movies, 'movie')
  );
  push(
    { id: 'discover-popular-shows', title: 'Popular TV Shows', subtitle: 'TMDB · sorted by rating · /discover', endpoint: '/discover' },
    tmdbList(data.popular?.shows, 'show')
  );
  push(
    { id: 'discover-top-rated-movies', title: 'Top Rated Movies', subtitle: 'TMDB · /discover', endpoint: '/discover' },
    tmdbList(data.topRated?.movies, 'movie')
  );
  push(
    { id: 'discover-top-rated-shows', title: 'Top Rated TV Shows', subtitle: 'TMDB · /discover', endpoint: '/discover' },
    tmdbList(data.topRated?.shows, 'show')
  );

  const traktLists = Array.isArray(data.traktLists) ? data.traktLists : [];
  for (const list of traktLists) {
    const items = (Array.isArray(list?.items) ? list.items : [])
      .map((entry) =>
        entry?.id != null
          ? fromIdOnly(entry.id, entry.type, { title: asString(entry.name), year: asNumber(entry.year), idOnly: !asString(entry.name) })
          : null
      )
      .filter(Boolean);
    push(
      {
        id: `trakt-list-${list?.name ? String(list.name).toLowerCase().replace(/\W+/g, '-') : rows.length}`,
        title: asString(list?.name) || 'Trakt list',
        subtitle: `${list?.likes ?? 0} likes · Trakt curated list · /discover`,
        endpoint: '/discover',
      },
      items
    );
  }

  /** @returns {any[]} */
  const genreList = (raw) => (Array.isArray(raw) ? raw : Array.isArray(raw?.genres) ? raw.genres : []);

  return {
    rows,
    rowsMeta,
    genres: {
      movies: genreList(data.genres?.movies).map((g) => ({ id: g.id, name: asString(g.name) })).filter((g) => g.name),
      shows: genreList(data.genres?.shows).map((g) => ({ id: g.id, name: asString(g.name) })).filter((g) => g.name),
    },
    itemCount: rows.reduce((sum, row) => sum + row.length, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Catalog: GET /letterboxd and GET /lists/:id                         */
/* ------------------------------------------------------------------ */

export function fromLetterboxd(payload) {
  const lists = Array.isArray(payload?.lists) ? payload.lists : [];
  const rows = [];
  const rowsMeta = [];

  lists.forEach((list, index) => {
    const items = (Array.isArray(list?.tmdbMovies) ? list.tmdbMovies : []).map((movie) => fromTmdb(movie, 'movie', '/letterboxd')).filter(Boolean);
    if (!items.length) return;
    rows.push(items);
    rowsMeta.push({
      id: `letterboxd-${index}`,
      title: asString(list?.listName) || 'Letterboxd list',
      subtitle: `${items.length} matched on TMDB · /letterboxd`,
      href: asString(list?.listUrl),
      endpoint: '/letterboxd',
    });
  });

  return { rows, rowsMeta, note: asString(payload?.error) };
}

export function fromPublicList(payload) {
  if (!payload || typeof payload !== 'object' || !payload.id) return null;
  const items = (Array.isArray(payload.list_items) ? payload.list_items : [])
    .map((entry) => fromIdOnly(entry?.tmdb_id, entry?.type))
    .filter(Boolean);
  return {
    id: String(payload.id),
    name: asString(payload.name) || 'Untitled list',
    description: asString(payload.description),
    isPublic: payload.public === true,
    createdAt: asString(payload.created_at),
    updatedAt: asString(payload.updated_at),
    items,
  };
}

/* ------------------------------------------------------------------ */
/* Catalog: provider metrics (public Prometheus endpoints)             */
/* ------------------------------------------------------------------ */

/**
 * @param {Record<string, { samples: any[], byName: Map<string, any[]> }>} parsedByWindow
 * @param {string[]} windows
 */
export function fromMetrics(parsedByWindow, windows) {
  const rows = [];
  const rowsMeta = [];
  const trendingByWindow = {};
  const providersByWindow = {};

  for (const window of windows) {
    const parsed = parsedByWindow[window];
    if (!parsed) continue;

    const watchSamples = parsed.byName.get(MEDIA_WATCH_METRICS[window]) || [];
    const ranked = aggregateWatchedTitles(watchSamples, { limit: 40 });
    trendingByWindow[window] = ranked;

    const items = ranked
      .map((entry) =>
        entry.tmdbId
          ? fromIdOnly(entry.tmdbId, entry.type, {
              title: entry.title,
              idOnly: !entry.title,
              facts: { watched: entry.watched, failed: entry.failed, providers: entry.providers },
              origin: `/metrics/${window}`,
            })
          : null
      )
      .filter(Boolean);

    if (items.length) {
      rows.push(items);
      rowsMeta.push({
        id: `metrics-trending-${window}`,
        title:
          window === 'daily'
            ? 'Trending on Aether · last 24h'
            : window === 'weekly'
              ? 'Trending on Aether · last 7 days'
              : 'Trending on Aether · last 30 days',
        subtitle: 'Successful plays reported to /metrics by the official apps',
        endpoint: `/metrics/${window}`,
      });
    }

    providersByWindow[window] = aggregateProviders(parsed.byName.get(PROVIDER_STATUS_METRICS[window]) || []);
  }

  return { rows, rowsMeta, trendingByWindow, providersByWindow };
}

/* ------------------------------------------------------------------ */
/* Account library (requires a bearer session, own user only)          */
/* ------------------------------------------------------------------ */

export function fromProgress(items) {
  return (Array.isArray(items) ? items : [])
    .map((entry) => {
      if (!entry || entry.tmdbId == null) return null;
      const duration = Number(entry.duration || 0);
      const watched = Number(entry.watched || 0);
      const percent = duration > 0 ? Math.min(100, Math.max(0, (watched / duration) * 100)) : 0;
      const season = entry.season?.number ?? null;
      const episode = entry.episode?.number ?? null;
      const episodeLabel = season != null && episode != null ? `S${season}E${episode}` : null;
      const item = fromStoredMeta(entry.tmdbId, entry.meta, {
        origin: '/users/:id/progress',
        episodeLabel,
        idOnly: !asString(entry.meta?.title),
      });
      if (!item) return null;
      item.userState = {
        percent: Math.round(percent),
        watchedSeconds: watched,
        durationSeconds: duration,
        updatedAt: asString(entry.updatedAt),
        episodeLabel,
      };
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.userState?.updatedAt || 0) - Date.parse(a.userState?.updatedAt || 0));
}

export function fromWatchHistory(items) {
  const mapped = (Array.isArray(items) ? items : [])
    .map((entry) => {
      if (!entry || entry.tmdbId == null) return null;
      const season = entry.season?.number ?? null;
      const episode = entry.episode?.number ?? null;
      const episodeLabel = season != null && episode != null ? `S${season}E${episode}` : null;
      const item = fromStoredMeta(entry.tmdbId, entry.meta, {
        origin: '/users/:id/watch-history',
        episodeLabel,
        idOnly: !asString(entry.meta?.title),
      });
      if (!item) return null;
      item.userState = {
        watchedAt: asString(entry.watchedAt),
        completed: entry.completed === true,
        percent: null,
        episodeLabel,
      };
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.userState?.watchedAt || 0) - Date.parse(a.userState?.watchedAt || 0));

  // Collapse per-episode rows into one card per title (most recent first).
  const seen = new Set();
  return mapped.filter((item) => {
    const key = itemKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fromBookmarks(items) {
  return (Array.isArray(items) ? items : [])
    .map((entry) => {
      if (!entry || entry.tmdbId == null) return null;
      const item = fromStoredMeta(entry.tmdbId, entry.meta, {
        origin: '/users/:id/bookmarks',
        idOnly: !asString(entry.meta?.title),
      });
      if (!item) return null;
      const groups = Array.isArray(entry.group) ? entry.group.filter(Boolean) : entry.group ? [entry.group] : [];
      item.userState = { groups, updatedAt: asString(entry.updatedAt) };
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.userState?.updatedAt || 0) - Date.parse(a.userState?.updatedAt || 0));
}

/** @param {any} payload `{ userId, ratings: [{ tmdb_id, type, rating }] }` */
export function fromRatings(payload) {
  const ratings = Array.isArray(payload?.ratings) ? payload.ratings : Array.isArray(payload) ? payload : [];
  return ratings
    .map((entry) => {
      const tmdbId = entry?.tmdb_id ?? entry?.tmdbId;
      if (tmdbId == null) return null;
      const item = fromIdOnly(tmdbId, normalizeType(entry.type));
      if (!item) return null;
      item.userState = { rating: asNumber(entry.rating) };
      item.origin = '/users/:id/ratings';
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => (b.userState?.rating ?? -1) - (a.userState?.rating ?? -1));
}

export function fromUserLists(payload) {
  const lists = Array.isArray(payload?.lists) ? payload.lists : Array.isArray(payload) ? payload : [];
  return lists.map((list) => ({
    id: String(list?.id || ''),
    name: asString(list?.name) || 'Untitled list',
    description: asString(list?.description),
    isPublic: list?.public === true,
    updatedAt: asString(list?.updated_at),
    items: (Array.isArray(list?.list_items) ? list.list_items : [])
      .map((entry) => fromIdOnly(entry?.tmdb_id, entry?.type))
      .filter(Boolean),
  }));
}

/* ------------------------------------------------------------------ */
/* Enrichment                                                          */
/* ------------------------------------------------------------------ */

/**
 * Builds a lookup of everything we have seen, so id-only records can borrow a
 * title/poster that the backend exposed elsewhere for the same TMDB id.
 * @param {Array<TitleItem[]|TitleItem|undefined|null>} sources
 */
export function buildTitleIndex(sources) {
  /** @type {Map<string, TitleItem>} */
  const index = new Map();
  const consider = (item) => {
    if (!item) return;
    const key = itemKey(item);
    if (!key) return;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, { ...item });
      return;
    }
    const merged = { ...existing };
    for (const field of ['title', 'year', 'overview', 'posterPath', 'backdropPath', 'rating', 'releaseDate']) {
      if (merged[field] == null && item[field] != null) merged[field] = item[field];
    }
    if ((!merged.genreIds || !merged.genreIds.length) && item.genreIds?.length) merged.genreIds = item.genreIds;
    if (!merged.posterPath && item.posterPath) merged.posterPath = item.posterPath;
    merged.idOnly = !merged.title;
    index.set(key, merged);
  };

  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) source.forEach(consider);
    else consider(source);
  }
  return index;
}

/**
 * Fills missing fields on id-only items from the index. Never overwrites data
 * that the record itself carried.
 * @template {TitleItem} T
 * @param {T[]} items
 * @param {Map<string, TitleItem>} index
 * @returns {T[]}
 */
export function enrichItems(items, index) {
  if (!index || !index.size) return items;
  return items.map((item) => {
    if (!item.idOnly && item.title && item.posterPath) return item;
    const known = index.get(itemKey(item));
    if (!known) return item;
    return {
      ...item,
      title: item.title || known.title,
      year: item.year ?? known.year,
      overview: item.overview || known.overview,
      posterPath: item.posterPath || known.posterPath,
      backdropPath: item.backdropPath || known.backdropPath,
      rating: item.rating ?? known.rating,
      genreIds: item.genreIds?.length ? item.genreIds : known.genreIds || [],
      idOnly: !(item.title || known.title),
    };
  });
}

/** Dedupe within a row, preserving order. */
export function dedupeRow(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = itemKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const TYPE_LABEL = {
  movie: 'Movie',
  show: 'TV Show',
  unknown: 'Title',
};
