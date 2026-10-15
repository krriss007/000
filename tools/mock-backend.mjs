/**
 * DEV TOOL — synthetic Aether backend.
 *
 * This sandbox's network allow-list blocks `backend.aether.cx`, so the app's
 * server path cannot be exercised against the real host from here. This mock
 * answers the same routes with the same *shapes* (payload field names copied
 * from the deployment's source) using obviously synthetic values, plus a real
 * Ed25519 challenge flow so the sign-in code path is genuinely verified.
 *
 *   node tools/mock-backend.mjs            # listens on 127.0.0.1:4999
 *   AETHER_BACKEND_URL=http://127.0.0.1:4999 node server/index.mjs
 *
 * It is never used in production and ships no real metadata.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';

const PORT = Number(process.env.MOCK_PORT || 4999);
const challenges = new Map();
const sessions = new Map();
const TOKEN_PREFIX = 'mock-token-';

const DEMO_USER_ID = '11111111-2222-3333-4444-555555555555';

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64');
}

const tmdbMovie = (id, title, year, rating, genreIds = [18]) => ({
  id,
  title,
  original_title: title,
  overview: `Synthetic synopsis for ${title} (${year}) supplied by the local mock backend.`,
  poster_path: `/mock-poster-${id}.jpg`,
  backdrop_path: `/mock-backdrop-${id}.jpg`,
  release_date: `${year}-01-01`,
  vote_average: rating,
  vote_count: 1200 + id,
  genre_ids: genreIds,
  popularity: 100 - (id % 50),
  original_language: 'en',
  video: false,
  adult: false,
});

const tmdbShow = (id, name, year, rating, genreIds = [16]) => ({
  id,
  name,
  original_name: name,
  overview: `Synthetic synopsis for ${name} (${year}) supplied by the local mock backend.`,
  poster_path: `/mock-poster-${id}.jpg`,
  backdrop_path: null,
  first_air_date: `${year}-01-01`,
  vote_average: rating,
  vote_count: 400 + id,
  genre_ids: genreIds,
  popularity: 80 - (id % 40),
  original_language: 'en',
});

const traktEntry = (movie, extra = {}) => ({
  ...extra,
  movie: {
    title: movie.title,
    year: Number(movie.release_date.slice(0, 4)),
    ids: { trakt: movie.id * 3, slug: `mock-${movie.id}`, imdb: `tt${movie.id}`, tmdb: movie.id },
  },
});

const DISCOVER = {
  mostWatched: [traktEntry(tmdbMovie(11, 'Mock Feature One', 2024, 7.9), { watcher_count: 512, play_count: 900, collected_count: 120 })],
  lastWeekend: [traktEntry(tmdbMovie(12, 'Mock Box Office', 2025, 6.4), { revenue: 18_400_000 })],
  trending: [traktEntry(tmdbMovie(13, 'Mock Trend', 2026, 8.2), { watchers: 7331 })],
  popular: {
    movies: [tmdbMovie(21, 'Popular Mock Movie', 2026, 8.6), tmdbMovie(22, 'Second Popular Mock', 2025, 7.1), tmdbMovie(12, 'Mock Box Office', 2025, 6.4)],
    shows: [tmdbShow(31, 'Popular Mock Show', 2024, 8.1), tmdbShow(32, 'Another Mock Show', 2023, 7.4)],
  },
  topRated: {
    movies: [tmdbMovie(41, 'Top Rated Mock', 1999, 9.1), tmdbMovie(11, 'Mock Feature One', 2024, 7.9)],
    shows: [tmdbShow(42, 'Top Rated Mock Show', 2018, 9.0)],
  },
  nowPlaying: {
    movies: [tmdbMovie(51, 'In Cinemas Mock', 2026, 7.7), tmdbMovie(13, 'Mock Trend', 2026, 8.2)],
    shows: [tmdbShow(52, 'On The Air Mock', 2022, 6.8)],
  },
  genres: {
    movies: { genres: [{ id: 18, name: 'Drama' }, { id: 28, name: 'Action' }] },
    shows: { genres: [{ id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' }] },
  },
  traktLists: [
    {
      name: 'Mock Curated List',
      likes: 42,
      items: [
        { type: 'movie', name: 'Listed Mock Film', id: 61, year: 2020 },
        { type: 'show', name: 'Listed Mock Show', id: 62, year: 2021 },
        { type: 'movie', name: 'Overlap Mock Film', id: 21, year: 2026 },
      ],
    },
  ],
};

const LETTERBOXD = {
  lists: [
    {
      listName: 'Mock Letterboxd Top 10',
      listUrl: 'https://letterboxd.com/mock/list/top-10/',
      tmdbMovies: [tmdbMovie(71, 'Letterboxd Mock One', 2015, 7.2), tmdbMovie(72, 'Letterboxd Mock Two', 2011, 8.8)],
      metadata: { originalFilmCount: 10, foundTmdbMatches: 2, expectedItemCount: 10, workingSelector: 'li.poster-container' },
    },
  ],
  totalLists: 1,
  summary: { totalTmdbMovies: 2, totalExpectedItems: 10 },
};

function metricsText(window) {
  return `# HELP mw_provider_status_count_${window} Number of provider requests by status (${window})
# TYPE mw_provider_status_count_${window} counter
mw_provider_status_count_${window}{provider_id="mock-fast",status="success"} 900
mw_provider_status_count_${window}{provider_id="mock-fast",status="failed"} 40
mw_provider_status_count_${window}{provider_id="mock-slow",status="success"} 120
mw_provider_status_count_${window}{provider_id="mock-slow",status="notfound"} 260

# HELP mw_media_watch_count_${window} Number of media watch events (${window})
# TYPE mw_media_watch_count_${window} counter
mw_media_watch_count_${window}{tmdb_full_id="movie-21",provider_id="mock-fast",title="Popular Mock Movie",success="true"} 412
mw_media_watch_count_${window}{tmdb_full_id="show-31",provider_id="mock-fast",title="Popular Mock Show",success="true"} 388
mw_media_watch_count_${window}{tmdb_full_id="movie-9999",provider_id="mock-slow",title="",success="true"} 91
mw_media_watch_count_${window}{tmdb_full_id="movie-51",provider_id="mock-slow",title="In Cinemas Mock",success="false"} 33

# HELP mw_provider_hostname_count_${window} Number of requests by provider hostname (${window})
# TYPE mw_provider_hostname_count_${window} counter
mw_provider_hostname_count_${window}{hostname="https://mock.example"} 1234

# HELP mw_user_count_${window} Number of users by namespace (${window})
# TYPE mw_user_count_${window} counter

# HELP mw_captcha_solves_${window} Number of captcha solves by success status (${window})
# TYPE mw_captcha_solves_${window} counter
mw_captcha_solves_${window}{status="success"} 12
`;
}

const json = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,HEAD,PUT,PATCH,POST,DELETE' });
  res.end(body);
};

const error = (res, status, path, message) =>
  json(res, status, { error: true, url: `http://127.0.0.1:${PORT}${path}`, statusCode: status, statusMessage: 'Server Error', message });

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,HEAD,PUT,PATCH,POST,DELETE' });
    return res.end();
  }

  // public
  if (path === '/' && req.method === 'GET') return json(res, 200, { message: 'Backend is working as expected (v2.1.0-mock)' });
  if (path === '/healthcheck' && req.method === 'GET') return json(res, 200, { message: '' });
  if (path === '/meta' && req.method === 'GET')
    return json(res, 200, { name: 'Mock Aether backend', description: 'Local synthetic stand-in for backend.aether.cx', version: '2.1.0', hasCaptcha: false, captchaClientKey: '' });
  if (path === '/discover' && req.method === 'GET') {
    // MOCK_BREAK_DISCOVER=1 reproduces the live deployment's current behaviour:
    // the aggregate endpoint fans out to TMDB + Trakt and answers 500.
    if (process.env.MOCK_BREAK_DISCOVER === '1') return error(res, 500, path, 'Server Error');
    return json(res, 200, DISCOVER);
  }
  if (path === '/letterboxd' && req.method === 'GET') return json(res, 200, LETTERBOXD);
  if (path.startsWith('/metrics/') && req.method === 'GET') {
    const window = path.split('/').pop();
    if (!['daily', 'weekly', 'monthly'].includes(window)) return error(res, 404, path, `Cannot find any route matching ${path}.`);
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'access-control-allow-origin': '*' });
    return res.end(metricsText(window));
  }
  if (path.startsWith('/lists/') && req.method === 'GET') {
    const id = path.split('/')[2];
    if (id !== 'mock-public-list') return error(res, 500, path, 'Server Error');
    return json(res, 200, {
      id,
      user_id: DEMO_USER_ID,
      name: 'Mock Public List',
      description: 'Synthetic list for local testing',
      public: true,
      created_at: new Date('2026-09-01T10:00:00Z').toISOString(),
      updated_at: new Date('2026-09-10T10:00:00Z').toISOString(),
      list_items: [
        { id: randomUUID(), list_id: id, tmdb_id: '21', type: 'movie', added_at: new Date().toISOString() },
        { id: randomUUID(), list_id: id, tmdb_id: '31', type: 'tv', added_at: new Date().toISOString() },
      ],
    });
  }

  // auth
  if (path === '/auth/login/start' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.publicKey) return error(res, 400, path, 'Invalid request body');
    const code = randomUUID();
    challenges.set(code, { flow: 'login', publicKey: body.publicKey, expires: Date.now() + 600000 });
    return json(res, 200, { challenge: code });
  }
  if (path === '/auth/login/complete' && req.method === 'POST') {
    const body = await readBody(req);
    const entry = challenges.get(body?.challenge?.code);
    if (!entry) return error(res, 401, path, 'Invalid challenge code');
    if (entry.publicKey !== body.publicKey) return error(res, 401, path, 'Invalid signature');
    const signature = decodeBase64Url(body.challenge.signature || '');
    const publicKey = decodeBase64Url(body.publicKey);
    const ok = nacl.sign.detached.verify(Buffer.from(body.challenge.code), signature, publicKey);
    if (!ok) return error(res, 401, path, 'Invalid signature');
    challenges.delete(body.challenge.code);
    const sessionId = randomUUID();
    const sessionToken = `${TOKEN_PREFIX}${sessionId}`;
    sessions.set(sessionToken, sessionId);
    return json(res, 200, {
      user: {
        id: DEMO_USER_ID,
        publicKey: body.publicKey,
        namespace: 'mock',
        nickname: 'Mock User',
        profile: { colorA: '#7c5cff', colorB: '#22d3ee', icon: 'popcorn' },
        permissions: [],
      },
      session: {
        id: sessionId,
        user: DEMO_USER_ID,
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 21 * 864e5).toISOString(),
        device: body.device || 'mock-device',
        userAgent: req.headers['user-agent'] || 'mock',
      },
      token: sessionToken,
    });
  }
  if (path === '/auth/register/start' && req.method === 'POST') {
    const code = randomUUID();
    challenges.set(code, { flow: 'registration', publicKey: null, expires: Date.now() + 600000 });
    return json(res, 200, { challenge: code });
  }
  if (path === '/auth/register/complete' && req.method === 'POST') {
    const body = await readBody(req);
    const entry = challenges.get(body?.challenge?.code);
    if (!entry) return error(res, 401, path, 'Invalid challenge code');
    const signature = decodeBase64Url(body.challenge.signature || '');
    const publicKey = decodeBase64Url(body.publicKey);
    if (!nacl.sign.detached.verify(Buffer.from(body.challenge.code), signature, publicKey)) return error(res, 401, path, 'Invalid signature');
    challenges.delete(body.challenge.code);
    const sessionId = randomUUID();
    const sessionToken = `${TOKEN_PREFIX}${sessionId}`;
    sessions.set(sessionToken, sessionId);
    return json(res, 200, {
      user: { id: DEMO_USER_ID, publicKey: body.publicKey, namespace: body.namespace || 'mock', nickname: 'New Mock User', profile: body.profile, permissions: [] },
      session: { id: sessionId, user: DEMO_USER_ID, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 21 * 864e5).toISOString(), device: body.device || 'mock-device' },
      token: sessionToken,
    });
  }
  if (path.startsWith('/sessions/') && req.method === 'DELETE') {
    if (!sessions.has(token)) return error(res, 401, path, 'Unauthorized');
    sessions.delete(token);
    return json(res, 200, { id: path.split('/')[2] });
  }

  // account (bearer only)
  if (path.startsWith('/users/')) {
    if (!sessions.has(token)) return error(res, 401, path, 'Unauthorized');
    if (path === '/users/@me') {
      return json(res, 200, {
        user: { id: DEMO_USER_ID, publicKey: 'mock-public-key', namespace: 'mock', nickname: 'Mock User', profile: { colorA: '#7c5cff', colorB: '#22d3ee' }, permissions: [] },
        session: { id: sessions.get(token), user: DEMO_USER_ID, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 21 * 864e5).toISOString(), device: 'mock-device' },
      });
    }
    if (path === `/users/${DEMO_USER_ID}/progress`) {
      return json(res, 200, [
        {
          id: randomUUID(),
          tmdbId: '21',
          episode: { id: null, number: null },
          season: { id: null, number: null },
          meta: { title: 'Popular Mock Movie', year: 2026, poster: '/mock-poster-21.jpg', type: 'movie' },
          duration: '7200',
          watched: '1800',
          updatedAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
        },
        {
          id: randomUUID(),
          tmdbId: '31',
          episode: { id: 'e1', number: 4 },
          season: { id: 's1', number: 2 },
          meta: { title: 'Popular Mock Show', year: 2024, poster: '/mock-poster-31.jpg', type: 'show' },
          duration: '2400',
          watched: '900',
          updatedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
        },
      ]);
    }
    if (path === `/users/${DEMO_USER_ID}/bookmarks`) {
      return json(res, 200, [
        {
          tmdbId: '72',
          meta: { title: 'Letterboxd Mock Two', year: 2011, poster: '/mock-poster-72.jpg', type: 'movie' },
          group: ['Watchlist'],
          favoriteEpisodes: [],
          updatedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
        },
        {
          tmdbId: '9999',
          meta: { title: null, type: 'movie' },
          group: [],
          favoriteEpisodes: [],
          updatedAt: new Date(Date.now() - 5 * 864e5).toISOString(),
        },
      ]);
    }
    if (path === `/users/${DEMO_USER_ID}/watch-history`) {
      return json(res, 200, [
        { tmdbId: '21', episode: {}, season: {}, meta: { title: 'Popular Mock Movie', year: 2026, poster: '/mock-poster-21.jpg', type: 'movie' }, duration: '7200', watched: '7200', watchedAt: new Date(Date.now() - 4 * 3600e3).toISOString(), completed: true },
        { tmdbId: '31', episode: { id: 'e2', number: 5 }, season: { id: 's1', number: 2 }, meta: { title: 'Popular Mock Show', year: 2024, poster: '/mock-poster-31.jpg', type: 'show' }, duration: '2400', watched: '2400', watchedAt: new Date(Date.now() - 40 * 3600e3).toISOString(), completed: true },
        { tmdbId: '31', episode: { id: 'e1', number: 4 }, season: { id: 's1', number: 2 }, meta: { title: 'Popular Mock Show', year: 2024, poster: '/mock-poster-31.jpg', type: 'show' }, duration: '2400', watched: '1200', watchedAt: new Date(Date.now() - 44 * 3600e3).toISOString(), completed: false },
      ]);
    }
    if (path === `/users/${DEMO_USER_ID}/ratings`) {
      return json(res, 200, { userId: DEMO_USER_ID, ratings: [{ tmdb_id: 21, type: 'movie', rating: 9 }, { tmdb_id: 61, type: 'movie', rating: 6.5 }] });
    }
    if (path === `/users/${DEMO_USER_ID}/lists`) {
      return json(res, 200, {
        lists: [
          {
            id: 'mock-public-list',
            user_id: DEMO_USER_ID,
            name: 'Mock Public List',
            description: 'Synthetic list for local testing',
            public: true,
            created_at: new Date('2026-09-01T10:00:00Z').toISOString(),
            updated_at: new Date('2026-09-10T10:00:00Z').toISOString(),
            list_items: [
              { id: randomUUID(), list_id: 'mock-public-list', tmdb_id: '41', type: 'movie', added_at: new Date().toISOString() },
              { id: randomUUID(), list_id: 'mock-public-list', tmdb_id: '42', type: 'tv', added_at: new Date().toISOString() },
            ],
          },
        ],
      });
    }
    if (path === `/users/${DEMO_USER_ID}/sessions`) {
      return json(res, 200, [
        { id: sessions.get(token), userId: DEMO_USER_ID, createdAt: new Date().toISOString(), accessedAt: new Date().toISOString(), device: 'mock-device', userAgent: 'mock-agent' },
      ]);
    }
    if (path === `/users/${DEMO_USER_ID}/settings`) {
      return json(res, 200, { id: DEMO_USER_ID, applicationTheme: 'aether', applicationLanguage: 'en', enableDiscover: true, homeSectionOrder: [] });
    }
    return error(res, 404, path, `Cannot find any route matching ${path}.`);
  }

  return error(res, 404, path, `Cannot find any route matching ${path}.`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] synthetic Aether backend on http://127.0.0.1:${PORT} — dev only, no real metadata`);
});
