/**
 * DEV TOOL — renders the real client bundle inside jsdom and asserts what a
 * user would actually see: rows from each backend source, the featured hero,
 * the "last fetched" indicator, client-side search, the detail sheet and the
 * Backend status view.
 *
 *   npm run build:domtest   # or: vite build --config web/vite.domtest.config.mjs
 *   node tools/dom-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 4999;
const APP_PORT = 3111;
const DIRECT_PORT = 3112;
const DEGRADED_PORT = 3114;
const MNEMONIC = 'mock mnemonic words for the local smoke test only alpha beta gamma delta';
const BUNDLE = path.join(ROOT, '.tmp-domtest', 'app.iife.js');

const children = [];
let failures = 0;

const check = (name, condition, detail) => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

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
    child.on('exit', (code) => reject(new Error(`${command} exited early (${code}): ${output.slice(-500)}`)));
    setTimeout(() => reject(new Error(`timeout waiting for ${command}: ${output.slice(-500)}`)), 15000);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, label, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (condition()) return true;
    await sleep(120);
  }
  console.log(`  … timed out waiting for ${label}`);
  return false;
}

async function main() {
  if (!fs.existsSync(BUNDLE)) throw new Error('bundle missing — build it with: vite build --config web/vite.domtest.config.mjs');
  const code = fs.readFileSync(BUNDLE, 'utf8');

  console.log('booting synthetic backend + app server…');
  await start('node', ['tools/mock-backend.mjs'], { MOCK_PORT: String(MOCK_PORT) }, /synthetic Aether backend/);
  await start('node', ['server/index.mjs'], {
    PORT: String(APP_PORT),
    AETHER_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}`,
    AETHER_MNEMONIC: MNEMONIC,
    AETHER_DATA_DIR: '.tmp-domtest/data',
  }, /listening on/);

  const base = `http://127.0.0.1:${APP_PORT}/`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}api/health`)).ok) break;
    } catch {
      /* retry */
    }
    await sleep(150);
  }

  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on('jsdomError', (error) => consoleErrors.push(error.message));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.join(' ')));

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: base,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, base), init);
  window.scrollTo = () => {};
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

  console.log('\nrendering the client bundle in jsdom…');
  window.eval(code);

  const document = window.document;
  const ready = await waitFor(() => document.querySelectorAll('.card').length > 4, 'cards to render');
  check('app mounted and rendered cards', ready, `${document.querySelectorAll('.card').length} cards`);

  const rowTitlesNow = () => [...document.querySelectorAll('.row__title')].map((node) => node.textContent || '');
  // account rows arrive one request after the catalog, so wait for them
  await waitFor(() => rowTitlesNow().some((title) => title === 'Continue Watching'), 'library rows');
  const rowTitles = rowTitlesNow();
  const heroTitle = document.querySelector('.hero__title')?.textContent || '';
  const pills = [...document.querySelectorAll('.pill')].map((node) => node.textContent || '');

  console.log('\nHome view');
  check('hero shows a featured title', heroTitle.length > 2, heroTitle);
  check('rows from /discover render', rowTitles.includes('In Cinemas') && rowTitles.includes('Popular Movies'), rowTitles.slice(0, 6).join(' | '));
  check('row from /metrics renders', rowTitles.some((title) => title.startsWith('Trending on Aether')), rowTitles.join(' | '));
  check('row from /letterboxd renders', rowTitles.some((title) => title.includes('Mock Letterboxd')), rowTitles.join(' | '));
  check('Trakt curated list renders as its own row', rowTitles.includes('Mock Curated List'), rowTitles.join(' | '));
  check('library rows render for the signed-in server', rowTitles.includes('Continue Watching') && rowTitles.includes('My List'), rowTitles.join(' | '));
  check('“last fetched” indicator is visible', pills.some((text) => /updated/.test(text)), pills.join(' | '));
  check('signed-in state shown in header', pills.some((text) => text.includes('signed in')), pills.join(' | '));
  check('progress bar rendered for continue-watching card', document.querySelectorAll('.card__progress').length > 0);
  check('id-only record is labelled', [...document.querySelectorAll('.card__badge--id')].length > 0);
  check('poster/backdrop requests point at TMDB when paths exist', [...document.querySelectorAll('img')].every((img) => !img.src || /image\.tmdb\.org|localhost|127\.0\.0\.1|^data:/.test(img.src)), [...document.querySelectorAll('img')].map((img) => img.src).slice(0, 3).join(' | '));

  console.log('\nDetail view (click a card)');
  const firstCard = document.querySelector('.card');
  firstCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const sheetOpen = await waitFor(() => Boolean(document.querySelector('.sheet')), 'detail sheet');
  check('detail sheet opens', sheetOpen);
  const facts = [...document.querySelectorAll('.fact__label')].map((node) => node.textContent);
  check('detail sheet lists backend facts', facts.includes('Source endpoint') && facts.includes('TMDB rating'), facts.join(' | '));
  check('detail sheet offers a TMDB link', Boolean(document.querySelector('.sheet a[href*="themoviedb.org"]')));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const sheetClosed = await waitFor(() => !document.querySelector('.sheet'), 'sheet to close');
  check('escape closes the sheet', sheetClosed);

  console.log('\nSearch (client-side over loaded records)');
  window.location.hash = '#/search?q=mock';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  const searchReady = await waitFor(() => document.querySelectorAll('.grid .card').length > 0, 'search results');
  check('search returns matches', searchReady, `${document.querySelectorAll('.grid .card').length} results`);
  const headText = document.querySelector('.page-head h1')?.textContent || '';
  check('search heading reflects the query', headText.includes('mock'), headText);
  window.location.hash = '#/search?q=zzzzz-nothing';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  const emptyReady = await waitFor(() => Boolean(document.querySelector('.empty')), 'empty state');
  check('empty search shows an empty state', emptyReady);

  console.log('\nFilter + pagination view');
  window.location.hash = '#/browse/all';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await waitFor(() => document.querySelectorAll('.grid .card').length > 0, 'browse grid');
  const filterSelects = document.querySelectorAll('.filters select');
  check('facet filters render', filterSelects.length >= 3, `${filterSelects.length} selects`);
  const pagerText = document.querySelector('.pager')?.textContent || '';
  check('pagination note explains client-side paging', /no pagination parameters|client-side/i.test(document.body.textContent || ''), pagerText);

  console.log('\nBackend status view');
  window.location.hash = '#/backend';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  const backendReady = await waitFor(() => document.querySelectorAll('table.data').length >= 3, 'backend tables');
  check('backend tables render', backendReady, `${document.querySelectorAll('table.data').length} tables`);
  const bodyText = document.body.textContent || '';
  check('route inventory lists verified endpoints', bodyText.includes('/discover') && bodyText.includes('/users/@me'));
  check('limitations are spelled out', /No search endpoint/.test(bodyText) && /No pagination/.test(bodyText));
  check('data path explained', /server \(app server → backend\)|direct \(browser → backend\)/.test(bodyText));
  check('no unhandled client errors', consoleErrors.filter((message) => !/Not implemented: window\.scrollTo/.test(message)).length === 0, consoleErrors.slice(0, 3).join(' | '));


  /* ------------------------------------------------------------------ */
  /* Phase 2: the fallback the preview actually uses here               */
  /* ------------------------------------------------------------------ */

  console.log('\nDirect-mode fallback (browser → backend, account features off)');
  await start('node', ['server/index.mjs'], {
    PORT: String(DIRECT_PORT),
    AETHER_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}`,
    AETHER_FORCE_DIRECT: '1',
    AETHER_DATA_DIR: '.tmp-domtest/data-direct',
  }, /listening on/);

  const directBase = `http://127.0.0.1:${DIRECT_PORT}/`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${directBase}api/health`)).ok) break;
    } catch {
      /* retry */
    }
    await sleep(150);
  }

  const directHealth = await (await fetch(`${directBase}api/health`)).json();
  check('health advertises the direct path', directHealth.dataPath === 'direct' && directHealth.serverPath.reachable === false, JSON.stringify(directHealth.serverPath));
  const blocked = await fetch(`${directBase}api/catalog`);
  check('server refuses to proxy in direct mode', blocked.status === 503 && (await blocked.clone().json()).code === 'SERVER_PATH_UNAVAILABLE', `status=${blocked.status}`);

  const directErrors = [];
  const directConsole = new VirtualConsole();
  directConsole.on('jsdomError', (error) => directErrors.push(error.message));
  directConsole.on('error', (...args) => directErrors.push(args.join(' ')));

  const directDom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: directBase,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: directConsole,
  });
  const directWindow = directDom.window;
  const upstreamCalls = [];
  directWindow.fetch = (input, init) => {
    const resolved = new URL(typeof input === 'string' ? input : input.url, directBase);
    if (resolved.port === String(MOCK_PORT)) upstreamCalls.push(resolved.pathname);
    return fetch(resolved, init);
  };
  directWindow.scrollTo = () => {};
  directWindow.matchMedia = directWindow.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

  directWindow.eval(code);
  const directDocument = directWindow.document;
  const directReady = await waitFor(() => directDocument.querySelectorAll('.card').length > 4, 'fallback cards');
  check('browser fetches the backend itself', directReady && upstreamCalls.includes('/discover'), upstreamCalls.slice(0, 6).join(', '));
  check('metrics + letterboxd fetched directly too', upstreamCalls.includes('/metrics/daily') && upstreamCalls.includes('/letterboxd'), upstreamCalls.join(', '));
  check('account endpoints never called from the browser', !upstreamCalls.some((path) => path.startsWith('/users')), upstreamCalls.join(', '));
  check('direct-mode banner shown', /Direct mode: this browser is talking to the backend itself/.test(directDocument.body.textContent || ''));
  check('header flags direct mode', [...directDocument.querySelectorAll('.pill')].some((node) => /direct mode/.test(node.textContent || '')));

  directWindow.location.hash = '#/library';
  directWindow.dispatchEvent(new directWindow.HashChangeEvent('hashchange'));
  const libNoteReady = await waitFor(() => /Account data is unavailable in direct mode/.test(directDocument.body.textContent || ''), 'direct-mode library note');
  check('library view explains the restriction', libNoteReady);
  check('no unhandled client errors in fallback mode', directErrors.filter((message) => !/Not implemented: window\.scrollTo/.test(message)).length === 0, directErrors.slice(0, 3).join(' | '));

/* ------------------------------------------------------------------ */
  /* Phase 3: the live deployment's current state (/discover → 500)     */
  /* ------------------------------------------------------------------ */

  console.log('\nDegraded mode (catalog endpoint failing)');
  await start('node', ['tools/mock-backend.mjs'], { MOCK_PORT: '4998', MOCK_BREAK_DISCOVER: '1' }, /synthetic Aether backend/);
  await start('node', ['server/index.mjs'], {
    PORT: String(DEGRADED_PORT),
    AETHER_BACKEND_URL: 'http://127.0.0.1:4998',
    AETHER_DATA_DIR: '.tmp-domtest/data-degraded',
  }, /listening on/);

  const degradedBase = `http://127.0.0.1:${DEGRADED_PORT}/`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${degradedBase}api/health`)).ok) break;
    } catch {
      /* retry */
    }
    await sleep(150);
  }

  const degradedErrors = [];
  const degradedConsole = new VirtualConsole();
  degradedConsole.on('jsdomError', (error) => degradedErrors.push(error.message));
  degradedConsole.on('error', (...args) => degradedErrors.push(args.join(' ')));

  const degradedDom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: degradedBase,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: degradedConsole,
  });
  degradedDom.window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, degradedBase), init);
  degradedDom.window.scrollTo = () => {};
  degradedDom.window.matchMedia = degradedDom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  degradedDom.window.eval(code);

  const degradedDocument = degradedDom.window.document;
  const degradedReady = await waitFor(() => degradedDocument.querySelectorAll('.card').length > 2, 'degraded cards');
  const degradedText = () => degradedDocument.body.textContent || '';
  check('catalog still renders when /discover fails', degradedReady, `${degradedDocument.querySelectorAll('.card').length} cards`);
  check('failure banner names the endpoint', /The catalog endpoint \/discover is failing/.test(degradedText()));
  check('banner offers a retry', [...degradedDocument.querySelectorAll('.note__actions button')].some((node) => /Retry/.test(node.textContent || '')));
  check('metrics row still present', [...degradedDocument.querySelectorAll('.row__title')].some((node) => /Trending on Aether/.test(node.textContent || '')));
  check('no discover rows invented', ![...degradedDocument.querySelectorAll('.row__title')].some((node) => /In Cinemas/.test(node.textContent || '')));
  check('source strip reports the 500', [...degradedDocument.querySelectorAll('.pill')].some((node) => /\/discover/.test(node.textContent || '') && /HTTP 500/.test(node.textContent || '')));
  check('hero degrades gracefully without artwork', Boolean(degradedDocument.querySelector('.hero__title')) && !degradedDocument.querySelector('.hero__bg'));
  check('no unhandled client errors in degraded mode', degradedErrors.filter((message) => !/Not implemented: window\.scrollTo/.test(message)).length === 0, degradedErrors.slice(0, 3).join(' | '));

  console.log(`\n${failures === 0 ? 'ALL UI CHECKS PASSED' : `${failures} UI CHECK(S) FAILED`}`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\ndom test crashed: ${error.message}`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
