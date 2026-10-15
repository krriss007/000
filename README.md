# Aether Catalog

A responsive, Netflix-style browsing front-end for the **Aether backend** at
`https://backend.aether.cx` (configurable). It renders only what that API
actually exposes, says where every row came from, and shows when each dataset
was last fetched.

```
npm install
npm run build     # bundles web/ → web-dist/
npm start         # http://localhost:3000  (PORT / HOST configurable)
```

Optional account access (read-only, server-side):

```bash
cp .env.example .env
# AETHER_MNEMONIC="word word …"   ← your Aether mnemonic (12–24 words)
```

---

## 1. What the backend exposes (recon summary)

Full notes, evidence and per-route verification: **[`docs/BACKEND.md`](docs/BACKEND.md)**.
Everything below was probed live on **2026-10-15** (read-only `GET`s) or read from
the deployment's own source — `athretv/aether-backend` v2.1.0, a Nitro + Prisma
fork of `p-stream/backend`.

**Public, anonymous**

| Endpoint | Live result | Used here |
| --- | --- | --- |
| `GET /` | `{"message":"Backend is working as expected (v2.1.0)"}` | version banner |
| `GET /meta` | name, description, version, `hasCaptcha:false` | status view |
| `GET /healthcheck` | `{"message":""}` | reachability probe |
| `GET /discover` | **HTTP 500 right now** — one aggregate that fans out to TMDB **and** Trakt | hero + 10 catalog rows when it answers |
| `GET /letterboxd` | `{"lists":[],"error":"No lists found"}` | Letterboxd rows |
| `GET /lists/:id` | one list by uuid; **403** when private | "open a public list" |
| `GET /metrics` | all-time Prometheus dump (tens of MB) | deliberately not fetched |
| `GET /metrics/daily` `/weekly` `/monthly` | provider health + most-watched titles per window | "Trending on Aether" rows, provider table |

**Account (bearer session token, own user id only)**

`GET /users/@me`, `/users/:id/{settings,progress,watch-history,bookmarks,ratings,lists,sessions}`,
`PATCH|DELETE /users/:id`, `DELETE /sessions/:sid` → all answered **401** without a
token, and a foreign id is rejected with 403. Sign-in itself is public:
`POST /auth/derive-public-key`, `POST /auth/login/{start,complete}`,
`POST /auth/register/{start,complete}`.

**Not deployed here:** `GET|POST /api/player/status`, `POST /api/jobs/run` (present in
upstream 2.1.5, 404 on this host). `GET /users/:id/recommendation` exists but is an
unimplemented stub.

### Access & authentication limitations

* **No search endpoint.** `/search` is 404 and `/discover` ignores query parameters
  (verified with `?query=`/`?type=`). Search in this app filters the records already
  fetched from the backend, and the UI states that plainly.
* **No pagination parameters** anywhere; `/discover` returns a fixed page-1 slice of
  each TMDB/Trakt collection and the account endpoints return complete lists. Paging
  here is client-side (24 per page) and labelled as such.
* **No per-title metadata endpoint**, so a detail view can only show fields that
  already arrived inside a list payload. TMDB records are rich; Trakt entries and
  stored list items may only carry a title or a **TMDB id** — those render as explicit
  "id only" cards with a TMDB link instead of invented metadata.
* **No cross-account browsing.** Sharing exists only through `GET /lists/:id` for
  lists the owner marked public.
* **`/discover` is failing on this deployment** (HTTP 500 — its TMDB/Trakt credentials
  or upstream calls). The app retries it on every refresh, shows the verbatim error,
  and keeps rendering the endpoints that do answer.
* **Artwork is not proxied**: poster/backdrop paths resolve to `image.tmdb.org`, so
  cards fall back to generated art when an image cannot load.
* **Rate limits**: no rate-limit middleware in the backend source, but Cloudflare
  fronts it and the instance is shared. This app adds TTL caching, request
  coalescing, per-route throttling, `Retry-After` handling and exponential backoff
  on 429/5xx, and surfaces cache age + last-fetch time in the UI.
* **The app is read-only.** Bookmark/progress/rating/list writes exist on the backend
  and are intentionally unused — nothing here can mutate an account.

## 2. How the app is built

```
shared/   environment-agnostic data layer (normalisation, Prometheus parsing, cache)
  normalize.js  metrics + Trakt/TMDB/list payloads → one item model
  sources.js    the single "read the backend" implementation (rows, cache meta, errors)
  route-table.js, prometheus.js, cache.js, transport-utils.js
server/   Express app: /api/* proxy, account handling, static client, SPA fallback
web/      Vite + React client (views, cards, rows, detail sheet, status view)
tools/    dev tools: synthetic backend, API smoke test, jsdom UI test
docs/     BACKEND.md — the recon write-up
```

**Two data paths, one loader**

1. **Server path (default).** The browser only talks to this app. The Express server
   fetches the backend, caches responses by TTL, coalesces concurrent loads and keeps
   the account credentials. The backend URL lives in `AETHER_BACKEND_URL`.
2. **Direct path (automatic fallback).** If the app server cannot reach the backend
   from its own network (firewalled sandbox, blocked egress, DNS), `/api/health`
   reports `dataPath: "direct"` and the browser calls the same **public** GET
   endpoints itself — the backend's CORS policy is `access-control-allow-origin: *`
   (verified live). Account features are switched off in this mode on purpose: the
   mnemonic must never enter the browser.

Both paths share `shared/sources.js`, so rows, dedupe, enrichment and "last fetched"
metadata are identical.

**Account handling (server-side only).** Login is the backend's mnemonic + Ed25519
challenge: the server derives the keypair (PBKDF2-HMAC-SHA256 → Ed25519, exactly like
`POST /auth/derive-public-key`), signs the challenge, exchanges it for a session token
and caches **only the token** in git-ignored `data/session.json` (mode 600). Signing
out calls `DELETE /sessions/:sid` to revoke it. The mnemonic itself is never written to
disk, never returned to the browser and never logged. "Create account" generates a
BIP39 mnemonic server-side and shows it exactly once — it is the only key to that
account.

### Features

* Featured hero with backdrop, rating, synopsis and provenance line.
* Horizontal, snap-scrolling rows with arrow controls; "See all" grid per row.
* Rows are built from whatever the backend returns: TMDB catalog rows, Trakt curated
  lists, "Trending on Aether" (24 h / 7 d / 30 d, opt-in), Letterboxd lists, and —
  when signed in — Continue Watching (with progress bars), My List, Watch history,
  Your ratings and your own lists.
* Detail sheet with every field the record carried, TMDB deep link, per-title facts and
  similar titles from the loaded catalog.
* Client-side search + facets (type, genre, decade, provider, sort) with pagination and
  honest "this is local filtering" copy.
* Backend view: connection state, per-endpoint freshness (status, item count, fetched
  at, cache TTL), provider health table, trending tables, public-list lookup, the full
  route inventory with verification status, the access limitations above, and the
  server cache snapshot.
* Loading skeletons, per-source error notes with retry, offline/unreachable banners,
  auto-refresh every 5 minutes, manual forced refresh, "updated X ago" pills, toasts.
* Responsive from ~320 px up, keyboard accessible, `prefers-reduced-motion` respected,
  CSP-restricted (images only from `image.tmdb.org`, connections only to self + the
  configured backend).

## 3. Verifying it

```bash
npm test          # build + API smoke test + jsdom UI test
npm run smoke     # boots tools/mock-backend.mjs + the real server, asserts the API
npm run uitest    # renders the real client bundle in jsdom and asserts the UI
```

Both suites cover three states, because all three matter here:

1. **normal** — every source answering;
2. **degraded** — `/discover` returning 500, exactly like the live deployment today
   (the app must keep rendering `/metrics` + `/letterboxd` rows, name the failing
   endpoint verbatim and still offer a retry);
3. **direct fallback** — the app server unable to reach the backend, so the browser
   does the fetching and account features are disabled.

`tools/mock-backend.mjs` is a **dev-only** synthetic stand-in: this sandbox's network
allow-list blocks `backend.aether.cx`, so the smoke tests run against a mock that
reproduces the deployment's payload shapes (and a real Ed25519 challenge flow, so the
sign-in code path is genuinely exercised). It contains no real metadata and is never
part of the running app.

To point the app at a different Aether instance, set `AETHER_BACKEND_URL` — the header,
footer and Backend view all display the effective URL.
