/**
 * Aether Catalog — application server.
 *
 * Serves the React client and a small JSON API. All backend traffic goes
 * through here by default, so:
 *   - the configured backend URL is never hard-coded in the browser,
 *   - account credentials (mnemonic / session token) stay on the server,
 *   - responses are cached, coalesced and rate-limit aware.
 *
 * If this host cannot reach the backend at all (e.g. a sandbox network
 * allow-list), `/api/health` reports `dataPath: "direct"` and the client falls
 * back to calling the same public endpoints itself — the backend allows CORS
 * from any origin. Account features stay server-only in that mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { config } from './config.mjs';
import { createTransport } from './transport.mjs';
import { AccountService } from './auth.mjs';
import { createAetherData, ENDPOINT_NOTES } from '../shared/sources.js';
import { DEFAULT_BACKEND_URL } from '../shared/transport-utils.js';
import { RECON_DATE, ROUTE_TABLE } from '../shared/route-table.js';

const transport = createTransport();
const data = createAetherData({
  backendUrl: config.backendUrl,
  transport: (path, options) => transport.request(path, options),
  windows: config.metricsWindows,
  dataPath: 'server',
});
const account = new AccountService({ transport });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const startedAt = Date.now();

function parseWindows(req) {
  const raw = String(req.query.windows || '').trim();
  if (!raw) return config.metricsWindows;
  const requested = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => ['daily', 'weekly', 'monthly'].includes(value));
  return requested.length ? [...new Set(requested)] : config.metricsWindows;
}

function wantsForce(req) {
  return req.query.force === '1' || req.query.force === 'true';
}

/** Simple per-IP rate limit so one tab cannot hammer the shared backend. */
const hits = new Map();
const RATE_LIMIT = Number(process.env.APP_RATE_LIMIT || 180); // requests / minute / IP
function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const window = hits.get(key) || [];
  const recent = window.filter((at) => now - at < 60_000);
  recent.push(now);
  hits.set(key, recent);
  res.setHeader('x-app-ratelimit-limit', String(RATE_LIMIT));
  res.setHeader('x-app-ratelimit-remaining', String(Math.max(0, RATE_LIMIT - recent.length)));
  if (recent.length > RATE_LIMIT) {
    return res.status(429).json({
      error: true,
      code: 'APP_RATE_LIMITED',
      message: `This app allows ${RATE_LIMIT} requests per minute per client. Try again shortly.`,
    });
  }
  next();
}

/** Refuses data calls when this host provably cannot reach the backend. */
async function requireServerPath(req, res, next) {
  const unavailable = config.forceDirect || (await transport.serverPathUnavailable());
  if (!unavailable) return next();
  const probe = transport.lastProbe;
  return res.status(503).json({
    error: true,
    code: 'SERVER_PATH_UNAVAILABLE',
    dataPath: 'direct',
    backendUrl: config.backendUrl,
    message:
      'The application server cannot reach the Aether backend from this network, so the request was not attempted here. The browser will query the backend directly (its CORS policy is open).',
    detail: probe?.error || null,
  });
}

function apiHandler(handler) {
  return async (req, res) => {
    try {
      const payload = await handler(req, res);
      if (res.headersSent) return;
      res.setHeader('cache-control', 'no-store');
      res.json(payload);
    } catch (error) {
      const status = error?.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
      console.error(`[aether] API error on ${req.method} ${req.originalUrl}: ${error?.message}`);
      res.status(status).json({
        error: true,
        code: error?.code || 'APP_ERROR',
        message: error?.message || 'Unexpected error',
        dataPath: 'server',
      });
    }
  };
}

function apiStatus(req, res, next) {
  res.setHeader('cache-control', 'no-store');
  next();
}

/* ------------------------------------------------------------------ */
/* health + overview                                                   */
/* ------------------------------------------------------------------ */

app.get(
  '/api/health',
  apiStatus,
  apiHandler(async () => {
    const probe = await transport.probe();
    // Make sure a server-side sign-in (AETHER_MNEMONIC / cached token) has settled
    // before reporting account state.
    await account.init().catch(() => {});
    const reachableFromServer = !config.forceDirect && probe.networkError !== true;
    return {
      app: {
        name: 'Aether Catalog',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        reconDate: RECON_DATE,
      },
      backend: {
        url: config.backendUrl,
        urlConfiguredViaEnv: config.backendUrlConfigured,
        defaultUrl: DEFAULT_BACKEND_URL,
      },
      dataPath: reachableFromServer ? 'server' : 'direct',
      serverPath: {
        used: reachableFromServer,
        reachable: reachableFromServer,
        checkedAt: new Date(probe.at || Date.now()).toISOString(),
        lastError: probe.error || null,
        forced: config.forceDirect,
        reason: reachableFromServer
          ? null
          : config.forceDirect
            ? 'Direct mode was forced with AETHER_FORCE_DIRECT=1 (dev/test switch) — the browser is querying the backend itself.'
            : 'Outbound HTTPS from the app server to the backend is blocked here, so the browser queries the backend directly. Account features stay disabled in that mode.',
      },
      rateLimit: {
        cooldownActive: transport.inCooldown,
        cooldownReason: transport.cooldownReason,
        appRequestsPerMinute: RATE_LIMIT,
      },
      account: account.publicSession(),
      cache: data.cache.snapshot(),
      metricsWindows: config.metricsWindows,
    };
  })
);

app.get(
  '/api/overview',
  rateLimit,
  apiStatus,
  requireServerPath,
  apiHandler(async (req) => {
    await account.init();
    const overview = await data.loadOverview({ force: wantsForce(req), windows: parseWindows(req) });
    return {
      ...overview,
      dataPath: 'server',
      account: account.publicSession(),
      routes: { reconDate: RECON_DATE, table: ROUTE_TABLE },
    };
  })
);

/* ------------------------------------------------------------------ */
/* catalog + library                                                   */
/* ------------------------------------------------------------------ */

/** Last catalog rows, reused to enrich account records that only carry ids. */
let lastCatalogRows = [];

app.get(
  '/api/catalog',
  rateLimit,
  apiStatus,
  requireServerPath,
  apiHandler(async (req) => {
    await account.init().catch(() => {});
    const catalog = await data.loadCatalog({ force: wantsForce(req), windows: parseWindows(req) });
    if (catalog.rows?.length) lastCatalogRows = catalog.rows;
    return { ...catalog, dataPath: 'server', account: account.publicSession() };
  })
);

app.get(
  '/api/library',
  rateLimit,
  apiStatus,
  requireServerPath,
  apiHandler(async (req) => {
    await account.init();
    if (!account.isSignedIn()) {
      return { signedIn: false, dataPath: 'server', reason: account.token ? 'session-pending' : 'no-session', account: account.publicSession() };
    }
    // Library records often only carry a TMDB id; borrow titles/artwork from the
    // catalog we already fetched, never from anywhere else.
    const library = await data.loadLibrary({
      token: account.token,
      userId: account.userId,
      catalogRows: lastCatalogRows,
      force: wantsForce(req),
    });
    return { ...library, dataPath: 'server', account: account.publicSession() };
  })
);

app.get(
  '/api/lists/:id',
  rateLimit,
  apiStatus,
  requireServerPath,
  apiHandler(async (req) => {
    const result = await data.loadPublicList(req.params.id, { force: wantsForce(req) });
    if (!result.list) {
      const status = result.result?.status === 403 ? 403 : result.result?.status === 404 ? 404 : 502;
      const error = new Error(result.source.error || 'Public list not available');
      error.statusCode = status;
      throw error;
    }
    return { list: result.list, source: result.source, dataPath: 'server' };
  })
);

/* ------------------------------------------------------------------ */
/* account                                                             */
/* ------------------------------------------------------------------ */

app.get(
  '/api/auth/session',
  apiStatus,
  apiHandler(async () => {
    await account.init();
    return { ...account.publicSession(), dataPath: 'server' };
  })
);

app.post(
  '/api/auth/login',
  rateLimit,
  apiStatus,
  apiHandler(async (req) => {
    account.throttleCheck();
    const mnemonic = String(req.body?.mnemonic || '');
    const session = await account.signIn(mnemonic, { method: 'login', device: String(req.body?.device || config.deviceName) });
    return { ...session, dataPath: 'server' };
  })
);

app.post(
  '/api/auth/register',
  rateLimit,
  apiStatus,
  apiHandler(async () => {
    account.throttleCheck();
    const { mnemonic, session } = await account.register();
    // Returned exactly once: this string *is* the account.
    return { ...session, mnemonic, dataPath: 'server', warning: 'Store this mnemonic now. Anyone holding it can sign in to this account, and it cannot be recovered.' };
  })
);

app.post(
  '/api/auth/logout',
  apiStatus,
  apiHandler(async () => {
    const result = await account.signOut();
    return { signedIn: false, ...result, dataPath: 'server' };
  })
);

/* ------------------------------------------------------------------ */
/* static client                                                       */
/* ------------------------------------------------------------------ */

const clientBuilt = fs.existsSync(path.join(config.webDist, 'index.html'));

app.use(
  express.static(config.webDist, {
    index: false,
    setHeaders(res, filePath) {
      if (/\/assets\/.+-[A-Za-z0-9_]{6,}\./.test(filePath)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('cache-control', 'no-cache');
      }
      if (filePath.endsWith('index.html')) setSecurityHeaders(res);
    },
  })
);

function setSecurityHeaders(res) {
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://image.tmdb.org",
      `connect-src 'self' ${config.backendUrl}`,
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      'frame-ancestors *',
    ].join('; ')
  );
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-content-type-options', 'nosniff');
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!clientBuilt) {
    return res
      .status(503)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Aether Catalog</title><body style="font:16px system-ui;background:#0b0b10;color:#eee;padding:40px">
        <h1>Client bundle missing</h1><p>Run <code>npm run build</code> to build the web client into <code>web-dist/</code>, then reload.</p></body>`
      );
  }
  setSecurityHeaders(res);
  res.setHeader('cache-control', 'no-cache');
  res.sendFile(path.join(config.webDist, 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: true, code: 'NOT_FOUND', message: `No app route for ${req.method} ${req.originalUrl}` });
});

app.use((error, req, res, _next) => {
  console.error('[aether] unhandled error', error);
  res.status(500).json({ error: true, code: 'APP_ERROR', message: error?.message || 'Unexpected error' });
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const server = app.listen(config.port, config.host, async () => {
  const probe = await transport.probe({ force: true });
  console.log(`[aether] Aether Catalog listening on http://${config.host}:${config.port}`);
  console.log(`[aether] backend: ${config.backendUrl}${config.backendUrlConfigured ? ' (from AETHER_BACKEND_URL)' : ' (default)'}`);
  console.log(
    `[aether] server-side reachability: ${
      probe.networkError ? 'BLOCKED — the browser will use the direct fallback path' : 'ok'
    }${probe.networkError ? ` (${probe.error})` : ''}`
  );
  console.log(`[aether] client bundle: ${clientBuilt ? 'web-dist/' : 'MISSING — run npm run build'}`);
  if (config.mnemonic) console.log('[aether] AETHER_MNEMONIC is set — signing in on the server.');
  await account
    .init()
    .then((session) => {
      if (session?.user) console.log(`[aether] signed in as ${session.user.nickname || session.user.namespace || session.user.id}`);
      else if (config.mnemonic) console.log('[aether] mnemonic present but sign-in did not complete (see warnings above).');
    })
    .catch((error) => console.warn(`[aether] account init failed: ${error.message}`));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[aether] ${signal} received, closing.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

export { app, transport, data, account, config, ENDPOINT_NOTES };
