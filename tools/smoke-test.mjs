/**
 * DEV TOOL — end-to-end smoke test.
 *
 * Boots the synthetic backend (tools/mock-backend.mjs) plus the real app server
 * pointed at it, then walks the API surface the UI depends on and asserts on the
 * normalised payloads. This is how the server path is verified in this sandbox,
 * where outbound HTTPS to backend.aether.cx is blocked.
 *
 *   node tools/smoke-test.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKeyPair } from '../server/auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 4999;
const APP_PORT = 3111;
const MNEMONIC = 'mock mnemonic words for the local smoke test only alpha beta gamma delta';

const children = [];
let failures = 0;

function log(message) {
  console.log(message);
}

function check(name, condition, detail) {
  if (condition) {
    log(`  ✓ ${name}`);
  } else {
    failures += 1;
    log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function start(command, args, env, readyMatch) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (readyMatch.test(output)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`process exited early (${code}): ${output.slice(-600)}`)));
    setTimeout(() => reject(new Error(`timeout waiting for ${command}: ${output.slice(-600)}`)), 15000);
  });
}

async function waitFor(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`no response from ${url}`);
}

const api = (suffix) => `http://127.0.0.1:${APP_PORT}${suffix}`;

async function main() {
  log('booting synthetic backend + app server…');
  await start('node', ['tools/mock-backend.mjs'], { MOCK_PORT: String(MOCK_PORT) }, /synthetic Aether backend/);
  await start('node', ['server/index.mjs'], {
    PORT: String(APP_PORT),
    AETHER_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}`,
    AETHER_MNEMONIC: MNEMONIC,
    AETHER_DATA_DIR: '.tmp-smoke',
  }, /listening on/);

  await waitFor(api('/api/health'));

  log('\nGET /api/health');
  const health = await (await fetch(api('/api/health'))).json();
  check('data path is server', health.dataPath === 'server', health.dataPath);
  check('server path reachable', health.serverPath.reachable === true);
  check('backend url from env', health.backend.url === `http://127.0.0.1:${MOCK_PORT}`, health.backend.url);
  check('mnemonic sign-in succeeded at boot', health.account?.signedIn === true, JSON.stringify(health.account));

  log('\nGET /api/catalog');
  const catalog = await (await fetch(api('/api/catalog'))).json();
  const rowIds = (catalog.rows || []).map((row) => row.id);
  check('catalog has rows', catalog.rows.length > 0, `rows=${catalog.rows.length}`);
  check('discover rows present', rowIds.includes('discover-popular-movies'), rowIds.join(','));
  check('metrics trending row present', rowIds.includes('metrics-trending-daily'), rowIds.join(','));
  check('letterboxd row present', rowIds.some((id) => id.startsWith('letterboxd')), rowIds.join(','));
  check('trakt curated list row present', rowIds.some((id) => id.startsWith('trakt-list')), rowIds.join(','));
  check('featured picked with artwork', Boolean(catalog.featured?.backdropPath), JSON.stringify(catalog.featured?.title));
  check('genres returned', catalog.genres.movies.length > 0 && catalog.genres.shows.length > 0);
  check('every source reported', (catalog.sources || []).length >= 4, `${(catalog.sources || []).length}`);
  const titlelessWatch = catalog.rows.find((row) => row.id === 'metrics-trending-daily');
  check('id-only trending record kept honest', titlelessWatch?.items.some((item) => item.idOnly === true));
  check('id-only record enriched from /discover when possible', titlelessWatch?.items.some((item) => item.tmdbId === '21' && item.title === 'Popular Mock Movie'));
  const providers = catalog.providers?.daily || [];
  check('provider aggregation', providers.some((provider) => provider.providerId === 'mock-fast' && provider.success === 900), JSON.stringify(providers[0]));

  log('\nGET /api/library');
  const library = await (await fetch(api('/api/library'))).json();
  const libraryRowIds = (library.rows || []).map((row) => row.id);
  check('library signed in', library.signedIn === true);
  check('continue watching row', libraryRowIds.includes('library-continue'));
  check('bookmarks row', libraryRowIds.includes('library-bookmarks'));
  check('history collapsed to unique titles', (library.rows.find((row) => row.id === 'library-history')?.items || []).length === 2);
  check('ratings row enriches title from other data', (library.rows.find((row) => row.id === 'library-ratings')?.items || []).some((item) => item.title === 'Popular Mock Movie'));
  check('user list row present', libraryRowIds.some((id) => id.startsWith('library-list-')));
  check('progress percentage computed', library.rows.find((row) => row.id === 'library-continue')?.items[0]?.userState?.percent === 25);

  log('\nGET /api/overview');
  const overview = await (await fetch(api('/api/overview'))).json();
  check('meta read', overview.meta?.version === '2.1.0', JSON.stringify(overview.meta));
  check('metrics summary per window', Object.keys(overview.metricsSummary || {}).length >= 2);
  check('route table exposed', overview.routes?.table?.length >= 3);
  check('no network error flagged', overview.networkError === false);

  log('\nGET /api/lists/:id');
  const list = await (await fetch(api('/api/lists/mock-public-list'))).json();
  check('public list loaded', list.list?.items?.length === 2, JSON.stringify(list.list?.name));
  const missing = await fetch(api('/api/lists/nope'));
  check('bad list id surfaces an error status', missing.status >= 400, `status=${missing.status}`);

  log('\nAccount flow (mnemonic → challenge → signature → token)');
  const other = await fetch(api('/api/lists/mock-public-list'));
  check('public endpoints still fine after login', other.ok);
  const healthAgain = await (await fetch(api('/api/health'))).json();
  check('session cached for the server', healthAgain.account?.signedIn === true);
  const derived = await deriveKeyPair(MNEMONIC);
  check('public key derivation is deterministic base64url', /^[A-Za-z0-9_-]+$/.test(derived.publicKey) && derived.publicKey.length === 43, derived.publicKey);

  log('\nAuth endpoints reject garbage');
  const badLogin = await fetch(api('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mnemonic: 'x' }) });
  check('short mnemonic rejected', badLogin.status === 400, `status=${badLogin.status}`);

  log('\nStatic client');
  const page = await fetch(api('/'));
  const html = await page.text();
  check('index.html served', page.ok && html.includes('Aether Catalog'));
  check('CSP header present', Boolean(page.headers.get('content-security-policy')));
  check('non-API path falls back to the SPA', (await fetch(api('/some/deep/link'))).ok);

/* Degraded mode: /discover 500s, exactly like backend.aether.cx today. */
  log('\nDegraded mode (/discover answers 500, as on the live deployment)');
  await start('node', ['tools/mock-backend.mjs'], { MOCK_PORT: '4998', MOCK_BREAK_DISCOVER: '1' }, /synthetic Aether backend/);
  await start('node', ['server/index.mjs'], {
    PORT: '3113',
    AETHER_BACKEND_URL: 'http://127.0.0.1:4998',
    AETHER_DATA_DIR: '.tmp-smoke/degraded',
  }, /listening on/);
  await waitFor('http://127.0.0.1:3113/api/health');

  const degraded = await (await fetch('http://127.0.0.1:3113/api/catalog')).json();
  const discoverSource = (degraded.sources || []).find((source) => source.endpoint === '/discover');
  check('catalog still returns rows from other sources', degraded.rows.length > 0, `rows=${degraded.rows.length}`);
  check('/discover failure reported verbatim', discoverSource?.ok === false && discoverSource?.status === 500, JSON.stringify(discoverSource));
  check('failure exposed as a note for the UI', Boolean(degraded.discoverNote), String(degraded.discoverNote));
  check('featured falls back to a source that works', Boolean(degraded.featured), degraded.featured?.title);
  check('no account state leaks without a session', degraded.account?.signedIn === false);

  log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\nsmoke test crashed: ${error.message}`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 250);
}
