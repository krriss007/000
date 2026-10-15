/**
 * Recon summary of the Aether backend surface, rendered in the app's
 * "Backend" panel so users can see exactly which endpoints this UI reads,
 * which ones are gated behind an account, and what was observed live.
 *
 * `verification: 'live'`   -> observed with a real GET on 2026-10-15
 * `verification: 'source'` -> read from the deployment's own source
 *                             (athretv/aether-backend v2.1.0), POST-only routes
 *                             that cannot be exercised from this sandbox
 * `verification: 'absent'` -> documented upstream but 404 on this deployment
 */

export const RECON_DATE = '2026-10-15';

/** @type {{ group: string, note?: string, routes: {method: string, path: string, auth: boolean, status: string, verification: 'live'|'source'|'absent', used?: boolean, note?: string}[] }[]} */
export const ROUTE_TABLE = [
  {
    group: 'Public',
    routes: [
      { method: 'GET', path: '/', auth: false, status: '200', verification: 'live', used: true, note: 'Version banner.' },
      { method: 'GET', path: '/meta', auth: false, status: '200', verification: 'live', used: true, note: 'Name, description, version, captcha flags.' },
      { method: 'GET', path: '/healthcheck', auth: false, status: '200', verification: 'live', used: true, note: 'Cheap liveness probe.' },
      {
        method: 'GET',
        path: '/discover',
        auth: false,
        status: '500',
        verification: 'live',
        used: true,
        note: 'Aggregate TMDB + Trakt catalog — currently failing on this deployment (upstream TMDB/Trakt credentials). The app retries on every refresh.',
      },
      { method: 'GET', path: '/letterboxd', auth: false, status: '200', verification: 'live', used: true, note: 'Scraped Letterboxd lists matched to TMDB. Currently answers "No lists found".' },
      { method: 'GET', path: '/lists/:id', auth: false, status: '200 / 403', verification: 'live', used: true, note: 'Public lists by uuid; 403 when the list is private.' },
      { method: 'GET', path: '/metrics', auth: false, status: '200', verification: 'live', used: false, note: 'All-time Prometheus dump, tens of MB — deliberately not fetched.' },
      { method: 'GET', path: '/metrics/daily', auth: false, status: '200', verification: 'live', used: true, note: 'Plays, providers and trending titles for the last 24h.' },
      { method: 'GET', path: '/metrics/weekly', auth: false, status: '200', verification: 'live', used: true, note: 'Same, last 7 days.' },
      { method: 'GET', path: '/metrics/monthly', auth: false, status: '200', verification: 'live', used: false, note: 'Same, last 30 days — opt-in in the app (largest payload).' },
      { method: 'POST', path: '/metrics/providers', auth: false, status: '—', verification: 'source', used: false, note: 'Telemetry write from official clients; not used (read-only app).' },
      { method: 'POST', path: '/metrics/captcha', auth: false, status: '—', verification: 'source', used: false, note: 'Telemetry write; not used.' },
    ],
  },
  {
    group: 'Sign-in (mnemonic + Ed25519, no passwords)',
    note: 'Handled entirely on the app server: the mnemonic never reaches the browser, only the session token it produces.',
    routes: [
      { method: 'POST', path: '/auth/login/start', auth: false, status: '—', verification: 'source', used: true, note: '{ publicKey } -> { challenge }.' },
      { method: 'POST', path: '/auth/login/complete', auth: false, status: '—', verification: 'source', used: true, note: 'Ed25519 signature over the challenge -> session token.' },
      { method: 'POST', path: '/auth/register/start', auth: false, status: '—', verification: 'source', used: true, note: 'Creates a new mnemonic-backed account (captcha disabled on this deployment).' },
      { method: 'POST', path: '/auth/register/complete', auth: false, status: '—', verification: 'source', used: true, note: 'Returns the account mnemonic exactly once.' },
      { method: 'POST', path: '/auth/derive-public-key', auth: false, status: '—', verification: 'source', used: false, note: 'The app derives the same keypair locally (PBKDF2-SHA256 → Ed25519), so the mnemonic is never sent to the backend.' },
    ],
  },
  {
    group: 'Your account (bearer session — own user id only)',
    note: 'Every route below answered 401 live without a token. Foreign user ids answer 403, so no one can browse another account.',
    routes: [
      { method: 'GET', path: '/users/@me', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Profile + session for the signed-in account.' },
      { method: 'GET', path: '/users/:id/settings', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Client preferences (theme, languages, providers).' },
      { method: 'GET', path: '/users/:id/progress', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Continue-watching positions.' },
      { method: 'GET', path: '/users/:id/watch-history', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Watch events, newest first.' },
      { method: 'GET', path: '/users/:id/bookmarks', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Bookmarks, grouped.' },
      { method: 'GET', path: '/users/:id/ratings', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Ratings you gave (TMDB id + score).' },
      { method: 'GET', path: '/users/:id/lists', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Your custom lists and their items.' },
      { method: 'GET', path: '/users/:id/sessions', auth: true, status: '401 without token', verification: 'live', used: true, note: 'Devices signed into this account.' },
      { method: 'DELETE', path: '/sessions/:sid', auth: true, status: '401 without token', verification: 'source', used: true, note: 'Revokes a session — used by "Sign out".' },
      { method: 'PUT/DELETE', path: '/users/:id/bookmarks/:tmdbid', auth: true, status: '401 without token', verification: 'source', used: false, note: 'Writes exist; this app is read-only and never mutates your account.' },
      { method: 'PUT', path: '/users/:id/progress', auth: true, status: '401 without token', verification: 'source', used: false, note: 'Write-only progress sync; unused.' },
      { method: 'POST', path: '/users/:id/ratings', auth: true, status: '401 without token', verification: 'source', used: false, note: 'Write; unused.' },
      { method: 'GET', path: '/users/:id/recommendation', auth: true, status: '500', verification: 'live', used: false, note: 'Deployed but unimplemented (returns nothing).' },
    ],
  },
  {
    group: 'Documented upstream, not deployed here',
    routes: [
      { method: 'GET/POST', path: '/api/player/status', auth: false, status: '404', verification: 'absent', used: false, note: 'Exists in upstream p-stream/backend 2.1.5; this host runs 2.1.0.' },
      { method: 'POST', path: '/api/jobs/run', auth: false, status: '404', verification: 'absent', used: false, note: 'Internal maintenance trigger; not deployed.' },
    ],
  },
];

export const KNOWN_GAPS = [
  'No search endpoint: `/search` is 404 and `/discover` ignores query parameters. Search here filters the records already fetched from the backend.',
  'No pagination parameters anywhere: `/discover` returns a fixed page-1 slice of each TMDB/Trakt collection and account endpoints return complete lists. Paging in this app is client-side.',
  'No per-title metadata endpoint: detail views can only show fields that list payloads already carried (TMDB records are rich; Trakt and stored list items may only have a title or an id).',
  'No public browsing of other accounts: only `GET /lists/:id` when the owner marked the list public.',
  'Artwork is not proxied by the backend — poster paths resolve to image.tmdb.org, so cards fall back to generated art when an image cannot load.',
  'No rate-limit middleware in the backend, but Cloudflare fronts it and the instance is shared: this app caches by TTL, coalesces concurrent loads, honours Retry-After and backs off on 429/5xx.',
];
