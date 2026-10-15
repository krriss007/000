/**
 * Minimal, dependency-free Prometheus text-format parser.
 *
 * The Aether backend exposes provider/usage metrics through prom-client at
 * `/metrics`, `/metrics/daily`, `/metrics/weekly` and `/metrics/monthly`.
 * Those bodies are plain text exposition format, e.g.
 *
 *   # HELP mw_media_watch_count_daily Number of media watch events (daily)
 *   # TYPE mw_media_watch_count_daily counter
 *   mw_media_watch_count_daily{tmdb_full_id="show-5371",provider_id="link",title="iCarly",success="true"} 41
 *
 * This module turns that into `{ name, labels, value }` samples and small
 * aggregation helpers. It runs unchanged in Node and in the browser.
 */

const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)(?:\s+\S+)?$/;

/** @typedef {{ name: string, labels: Record<string,string>, value: number }} Sample */

/** @param {string} raw @returns {Record<string,string>} */
function parseLabels(raw) {
  /** @type {Record<string,string>} */
  const labels = {};
  if (!raw) return labels;
  // label values may contain escaped quotes / backslashes
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    labels[match[1]] = match[2].replace(/\\(.)/g, '$1');
  }
  return labels;
}

/**
 * @param {string} text
 * @returns {{ samples: Sample[], byName: Map<string, Sample[]>, names: string[], parsedAt: string }}
 */
export function parsePrometheus(text) {
  /** @type {Sample[]} */
  const samples = [];
  /** @type {Map<string, Sample[]>} */
  const byName = new Map();
  /** @type {Set<string>} */
  const names = new Set();

  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = SAMPLE_RE.exec(trimmed);
    if (!match) continue;

    const name = match[1];
    const value = Number.parseFloat(match[4]);
    if (Number.isNaN(value)) continue;

    /** @type {Sample} */
    const sample = { name, labels: parseLabels(match[3] || ''), value };
    samples.push(sample);
    names.add(name);
    const bucket = byName.get(name);
    if (bucket) bucket.push(sample);
    else byName.set(name, [sample]);
  }

  return { samples, byName, names: [...names], parsedAt: new Date().toISOString() };
}

export const MEDIA_WATCH_METRICS = {
  daily: 'mw_media_watch_count_daily',
  weekly: 'mw_media_watch_count_weekly',
  monthly: 'mw_media_watch_count_monthly',
};

export const PROVIDER_STATUS_METRICS = {
  daily: 'mw_provider_status_count_daily',
  weekly: 'mw_provider_status_count_weekly',
  monthly: 'mw_provider_status_count_monthly',
};

const TITLE_TYPE_PREFIXES = {
  movie: 'movie',
  film: 'movie',
  show: 'show',
  tv: 'show',
  series: 'show',
};

/**
 * `tmdb_full_id` looks like `movie-550` or `show-60625`.
 * @param {string} fullId
 * @returns {{ type: 'movie'|'show'|'unknown', tmdbId: string|null }}
 */
export function splitFullId(fullId) {
  const raw = String(fullId || '');
  const idx = raw.indexOf('-');
  if (idx === -1) return { type: 'unknown', tmdbId: raw || null };
  const prefix = raw.slice(0, idx).toLowerCase();
  const id = raw.slice(idx + 1);
  return {
    type: /** @type {any} */ (TITLE_TYPE_PREFIXES[prefix] || 'unknown'),
    tmdbId: /^\d+$/.test(id) ? id : null,
  };
}

/**
 * Aggregates `mw_media_watch_count_*` into a ranked list of titles.
 * Only successful watches count towards the ranking; failures are reported
 * separately so the UI can be honest about provider flakiness.
 *
 * @param {Sample[]} samples
 * @param {{ limit?: number }} [options]
 */
export function aggregateWatchedTitles(samples, options = {}) {
  const limit = options.limit ?? 40;
  /** @type {Map<string, any>} */
  const byId = new Map();

  for (const sample of samples) {
    const fullId = sample.labels.tmdb_full_id;
    if (!fullId) continue;
    const { type, tmdbId } = splitFullId(fullId);
    const entry = byId.get(fullId) || {
      fullId,
      tmdbId,
      type,
      title: sample.labels.title || null,
      providerIds: new Set(),
      watched: 0,
      failed: 0,
      events: 0,
    };
    if (sample.labels.title) entry.title = entry.title || sample.labels.title;
    if (sample.labels.provider_id) entry.providerIds.add(sample.labels.provider_id);

    entry.events += sample.value;
    if (sample.labels.success === 'true') entry.watched += sample.value;
    else entry.failed += sample.value;
    byId.set(fullId, entry);
  }

  return [...byId.values()]
    .map((entry) => ({
      fullId: entry.fullId,
      tmdbId: entry.tmdbId,
      type: entry.type,
      title: entry.title,
      providers: [...entry.providerIds].sort(),
      watched: entry.watched,
      failed: entry.failed,
      events: entry.events,
    }))
    .filter((entry) => entry.watched > 0)
    .sort((a, b) => b.watched - a.watched || (a.title || '').localeCompare(b.title || ''))
    .slice(0, limit);
}

/**
 * Aggregates `mw_provider_status_count_*` per provider.
 * @param {Sample[]} samples
 */
export function aggregateProviders(samples) {
  /** @type {Map<string, any>} */
  const byProvider = new Map();

  for (const sample of samples) {
    const id = sample.labels.provider_id || 'unknown';
    const entry = byProvider.get(id) || {
      providerId: id,
      success: 0,
      failed: 0,
      notfound: 0,
      total: 0,
    };
    const status = (sample.labels.status || '').toLowerCase();
    if (status === 'success') entry.success += sample.value;
    else if (status === 'failed') entry.failed += sample.value;
    else if (status === 'notfound') entry.notfound += sample.value;
    entry.total += sample.value;
    byProvider.set(id, entry);
  }

  return [...byProvider.values()]
    .map((entry) => ({
      ...entry,
      successRate: entry.total > 0 ? entry.success / entry.total : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * @param {Sample[]} samples
 * @param {string} labelName
 */
export function aggregateByLabel(samples, labelName) {
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const sample of samples) {
    const key = sample.labels[labelName] || 'unknown';
    totals.set(key, (totals.get(key) || 0) + sample.value);
  }
  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}
