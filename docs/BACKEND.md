# Aether backend — API recon notes

Target: **`https://backend.aether.cx`** (default; configurable via `AETHER_BACKEND_URL`).
Recon date: **2026-10-15**. All probes were read-only HTTP `GET` requests.
Everything below is either (a) observed live, or (b) read from the backend's own source,
which is a public fork of the OpenBackend / movie-web "BackendV2" Nitro+Nitro/Prisma
service: `athretv/aether-backend` (package version `2.1.0`, matching `GET /meta` on the
live host) whose upstream is `p-stream/backend`.

> This sandbox can only reach a small allow-list of hosts (`github.com`, npm, pypi), so
> live probes were performed through a read-only fetching service. Consequence: **only
> `GET` routes could be probed live** — every `POST`/`PUT`/`PATCH`/`DELETE` row below is
> marked as *source-verified, not live-verified*.

---

## 1. What the backend is

| Item | Value |
| --- | --- |
| Root | `{"message":"Backend is working as expected (v2.1.0)"}` |
| `GET /meta` | `{"name":"Aether's backend","description":"Just backend for aether.mom","version":"2.1.0","hasCaptcha":false,"captchaClientKey":""}` |
| `GET /healthcheck` | `{"message":""}` |
| Framework | Nitro (h3) on Node.js `v23.11.1`, Prisma + Postgres, prom-client |
| Edge | Cloudflare in front (`server: cloudflare`, `cf-cache-status: DYNAMIC`) |
| CORS | fully open: `access-control-allow-origin: *`, `access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE`, `access-control-allow-headers: *` |
| Content model | The backend itself stores **no media**. It exposes TMDB/Trakt/Letterboxd derived metadata, account data, and provider health metrics. |
| Error envelope | `{ error: true, url, statusCode, statusMessage, message }` |

## 2. Route inventory

Legend: **✅ live-verified** · **⚠️ exists but currently failing** · **🔒 requires `Authorization: Bearer <session-token>`** · **📄 source-verified only**

### Public / anonymous

| Method | Path | Status | What it returns |
| --- | --- | --- | --- |
| GET | `/` | ✅ | version banner |
| GET | `/meta` | ✅ | site name/description/version, `hasCaptcha` + `captchaClientKey` |
| GET | `/healthcheck` | ✅ | `{"message":""}` |
| GET | `/discover` | ⚠️ **HTTP 500** | Full catalog aggregate: `popular{ movies, shows }`, `topRated{ movies, shows }`, `nowPlaying{ movies, shows }`, `genres{ movies, shows }`, `trending`, `mostWatched`, `lastWeekend`, `traktLists[]{ name, likes, items[]{ type, name, id, year } }` |
| GET | `/letterboxd` | ✅ | `{ lists[]{ listName, listUrl, tmdbMovies[], metadata }, totalLists, summary }` — currently `{"lists":[],"error":"No lists found"}` |
| GET | `/lists/:id` | ✅ | A single list by uuid incl. `list_items[]`; **403** when `public=false`. Unknown id currently 500s (upstream bug: dereferences `null`). |
| GET | `/metrics` | ✅ | Prometheus exposition (all-time). Very large (tens of MB) — the app does not fetch it. |
| GET | `/metrics/daily` | ✅ | Prometheus counters for the current day |
| GET | `/metrics/weekly` | ✅ | Prometheus counters for the week |
| GET | `/metrics/monthly` | ✅ | Prometheus counters for the month |
| POST | `/metrics/providers`, `/metrics/providers` (PUT), `/metrics/captcha` | 📄 | Telemetry *writes* made by the official client. Not used by this app. |

Prometheus series that are actually useful as content (all public, aggregated, no user identifiers):

* `mw_media_watch_count_{daily,weekly,monthly}{tmdb_full_id="movie-123",title="…",provider_id,success}` — most-watched titles.
* `mw_provider_status_count_{…}{provider_id,status="success|failed|notfound"}` — provider health.
* `mw_provider_hostname_count_{…}{hostname}` — referring hostnames.
* `mw_user_count_{…}{namespace}`, `mw_captcha_solves_{…}{status}` — usually empty (counters are only incremented by client telemetry).

### Authentication (public endpoints, but `POST`-only → not live-verifiable here)

The account system is **mnemonic + Ed25519**, no passwords, no email, no OAuth:

| Method | Path | Body → response |
| --- | --- | --- |
| POST | `/auth/derive-public-key` | `{mnemonic}` → `{publicKey}` (PBKDF2-HMAC-SHA256, salt `"mnemonic"`, 2048 iters, 32-byte seed → Ed25519 keypair, base64url) |
| POST | `/auth/register/start` | `{captchaToken?}` → `{challenge}` |
| POST | `/auth/register/complete` | `{publicKey, challenge:{code,signature}, namespace, device, profile:{colorA,colorB,icon}}` → `{user, session, token}` |
| POST | `/auth/login/start` | `{publicKey}` → `{challenge}` (**401** `User cannot be found` if unknown) |
| POST | `/auth/login/complete` | `{publicKey, challenge:{code,signature}, device}` → `{user, session, token}` |

* Challenges are `randomUUID()` values, valid **10 minutes**, single-use.
* The signature is `nacl.sign.detached(challengeCode, secretKey)`, base64url.
* The session token is a JWT (`{sid}`) signed with the server's `CRYPTO_SECRET`, sessions live **21 days** and are bumped on every authenticated request.

### Account data — 🔒 bearer token, and only ever **your own** user id

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users/@me` | ✅ live → **401 Unauthorized** without a token. Returns `{user:{id,publicKey,namespace,nickname,profile,permissions}, session}` |
| PATCH / DELETE | `/users/:id` | 403 unless `session.user === :id` |
| GET / PUT | `/users/:id/settings` | 403 unless own id |
| GET / PUT / DELETE | `/users/:id/bookmarks` | 403 unless own id |
| GET / PUT / DELETE | `/users/:id/bookmarks/:tmdbid` | single bookmark |
| GET / PUT / DELETE | `/users/:id/progress` (+ `/progress/:tmdb_id`, `/progress/import`, `/progress/cleanup`) | "continue watching" |
| GET | `/users/:id/watch-history` (+ `/watch-history/:tmdbid`) | |
| GET / POST | `/users/:id/ratings` | |
| GET | `/users/:id/sessions` | |
| GET / POST / PATCH / DELETE | `/users/:id/lists` (+ `/:listId`) | |
| GET | `/users/:id/group-order` | bookmark group ordering |
| GET | `/users/:id/recommendation` | ⚠️ deployed **stub** — returns nothing (HTTP 500) |
| GET / DELETE | `/sessions/:sid` | single session |

All of these returned **401** live for a foreign user id, i.e. they exist but are closed.
**There is no way to browse another account's library.** Public sharing only exists through
`GET /lists/:id` when a list is explicitly marked `public`.

### Documented upstream but NOT deployed on `backend.aether.cx`

| Method | Path | Live result |
| --- | --- | --- |
| GET/POST | `/api/player/status` | **404 – Cannot find any route matching** |
| POST | `/api/jobs/run` | not deployed |

(These exist in upstream `p-stream/backend` `2.1.5`; the deployed fork is `2.1.0`.)

## 3. Limitations that shaped the app

1. **`GET /discover` is currently returning HTTP 500.** Its handler proxies TMDB + Trakt in one
   shot, so a missing/invalid `TMDB_API_KEY` or `TRAKT_CLIENT_ID`/`TRAKT_SECRET_ID` on the
   deployment breaks the whole aggregate. The app therefore attempts it on every refresh,
   shows the verbatim failure in the UI, and still renders everything else that works.
2. **There is no search endpoint.** No `/search`, no query handling in `/discover` (verified:
   `?query=…` and `?type=…` change nothing). Search in this app is client-side over the
   records already fetched from the backend, and the UI says so.
3. **There is no pagination.** No `page`/`limit`/`offset`/cursor parameter is implemented
   anywhere; `/discover` returns a fixed page-1 slice of each TMDB/Trakt collection, and the
   account endpoints return complete lists. The app paginates *locally* and labels it as such.
4. **There is no per-title metadata endpoint.** A detail view can only show the fields that the
   list payload already carried (TMDB objects carry title/overview/poster/backdrop/genres;
   Trakt entries only carry title/year/tmdb id; `list_items` carry only a TMDB id + type).
   Where the backend gives no title or artwork, the app shows an explicit "id only" card
   instead of inventing data.
5. **Artwork host.** Poster/backdrop paths are TMDB paths, so images resolve to
   `https://image.tmdb.org`. The backend never proxies images. Cards fall back to generated
   gradient placeholders when an image cannot load.
6. **Rate limiting.** No rate-limit middleware exists in the backend source, but Cloudflare sits
   in front of it and the container is shared. The server therefore adds TTL caching +
   request coalescing + per-route throttling, honours `Retry-After`, backs off on `429`/`5xx`,
   and exposes "last fetched" + cache state to the UI.
7. **Writes exist but this app is read-only.** `PUT/POST/DELETE` account routes are documented
   above and deliberately unused — nothing this app does can mutate your account.
8. **Root site `aether.cx` is a separate SPA** (movie-web lineage, VidBinge-style
   `public/config.js`) that talks to TMDB directly from the browser. It is *not* part of the
   backend API surface, and this app does not depend on it.

## 4. How this app maps the API

| UI surface | Backend call |
| --- | --- |
| Header status, "last fetched", status drawer | `GET /meta`, `GET /healthcheck`, `GET /` |
| Hero video-wall, "In Cinemas", "Trending Now", "Most Watched", "Box Office", "Popular", "Top Rated", "Trakt lists" rows, genre chips | `GET /discover` (only when it succeeds) |
| "Trending on Aether — 24 h / 7 d / 30 d" rows, provider health table | `GET /metrics/daily|weekly|monthly` |
| "Letterboxd lists" rows | `GET /letterboxd` |
| Account chip, "Continue Watching", "Watch history", "My List", "Your ratings", "Your lists" | `GET /users/@me`, `/users/:id/progress`, `/watch-history`, `/bookmarks`, `/ratings`, `/lists`, `/settings`, `/sessions` (bearer) |
| "Open a public list" (by uuid) | `GET /lists/:id` |
| Sign in / create account | `POST /auth/login/{start,complete}`, `POST /auth/register/{start,complete}`, `POST /auth/derive-public-key` (server-side only) |
