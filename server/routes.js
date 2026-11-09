'use strict';
/**
 * REST + SSE API. No API secrets ever leave the server; all trading flows go through
 * explicit confirmation endpoints; every mutation is audited.
 */
const express = require('express');
const { feeSchedule, withdrawalFee, transferDelayMin, FEE_SCHEDULES } = require('./fees');
const { evaluateAll } = require('./arbitrage');
const { riskStatus } = require('./risk');
const { LIVE_TRADING_VENUES } = require('./exchanges');
const { masterKeySource, STALE_AFTER_MS } = require('./config');

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'BTC/USD', 'ETH/USD', 'SOL/USD'];
const LIVE_VENUES = ['binance', 'kraken', 'coinbase'];
const SIM_VENUES = ['sim_binance', 'sim_kraken', 'sim_coinbase'];

function buildRouter(ctx) {
  const { store, vault, audit, marketData, trading, venueIds } = ctx;
  const router = express.Router();

  const engineOpts = () => {
    const s = store.get().settings;
    return {
      feeFor: (v) => { const o = s.feeOverrides && s.feeOverrides[v]; return o && typeof o.taker === 'number' ? o.taker : feeSchedule(v).taker; },
      maxNotional: s.maxTradeNotional,
      maxSlippagePct: s.maxSlippagePct,
      fundingCostBps: s.fundingCostBps,
      amortizedTransferCost: s.amortizedTransferCost,
      quoteRate: (q) => { const r = s.quoteEquivalence || {}; return typeof r[q] === 'number' ? r[q] : 1; },
      venueCapabilities: Object.fromEntries(venueIds.map(id => [id, { analysisOnly: id === 'coinbase' }])),
      isSimulated: (v) => v.startsWith('sim_'),
    };
  };
  const computeOpportunities = () => {
    const books = marketData.getBooks({ includeStale: true });
    const opps = evaluateAll(books, engineOpts());
    const now = Date.now();
    for (const o of opps) {
      // Staleness per opportunity
      const bBuy = books[o.buySymbol] && books[o.buySymbol][o.buyVenue];
      const bSell = books[o.sellSymbol] && books[o.sellSymbol][o.sellVenue];
      const staleBuy = !bBuy || (now - (bBuy.ts || 0)) > STALE_AFTER_MS;
      const staleSell = !bSell || (now - (bSell.ts || 0)) > STALE_AFTER_MS;
      o.stale = staleBuy || staleSell;
      o.executable = !o.stale;
      if (o.stale) o.warnings.push('STALE MARKET DATA — this opportunity is shown for visibility but CANNOT be traded');
    }
    return opps;
  };

  // ---------- Meta / health ----------
  router.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString(), dataMode: ctx.dataMode }));

  router.get('/bootstrap', (req, res) => {
    const health = marketData.snapshot();
    res.json({
      ts: new Date().toISOString(),
      dataMode: ctx.dataMode,
      masterKeySource,
      symbols: SYMBOLS,
      liveVenues: LIVE_VENUES, simVenues: SIM_VENUES, liveTradingVenues: [...LIVE_TRADING_VENUES],
      feeSchedules: FEE_SCHEDULES,
      withdrawalFees: withdrawalFeeMap(), transferDelaysMin: delayMap(),
      health: health.health, staleAfterMs: STALE_AFTER_MS,
      settings: publicSettings(store.get().settings),
    });
  });

  // ---------- Opportunities ----------
  router.get('/opportunities', (req, res) => {
    try {
      const opps = computeOpportunities();
      const s = store.get().settings;
      const fresh = opps.filter(o => !o.stale);
      res.json({
        ts: new Date().toISOString(),
        count: opps.length,
        opportunities: opps.slice(0, 60),
        actionable: fresh.filter(o => o.netPnlUSD > 0 && o.netReturnPct * 100 >= s.minNetReturnBps).length,
        health: marketData.snapshot().health,
        disclaimer: 'Opportunities are estimates. Price differences can disappear before execution; fees, slippage, latency, liquidity, transfer delays and outages can turn an apparent opportunity into a loss. No profit is guaranteed.',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/books', (req, res) => {
    const symbol = String(req.query.symbol || '');
    const books = marketData.getBooks({ includeStale: true });
    if (!symbol) return res.status(400).json({ error: 'symbol query parameter required (e.g. BTC/USDT)' });
    res.json({ symbol, books: books[symbol] || {}, ts: Date.now() });
  });

  router.get('/price-history', (req, res) => {
    const { venue, symbol } = req.query;
    if (!venue || !symbol) return res.status(400).json({ error: 'venue and symbol query parameters required' });
    res.json({ venue, symbol, points: marketData.priceHistory(String(venue), String(symbol)) });
  });

  // ---------- Settings ----------
  router.get('/settings', (req, res) => res.json({ settings: publicSettings(store.get().settings), risk: riskStatus(store) }));

  router.put('/settings', (req, res) => {
    const body = req.body || {};
    const s0 = store.get().settings;
    const changes = [];
    const bool = (v) => v === true || v === 'true';
    store.update(st => {
      const s = st.settings; // st is the STATE ROOT; settings live at st.settings
      const numFields = ['maxTradeNotional', 'maxDailyLoss', 'maxOpenPositions', 'minNetReturnBps', 'fundingCostBps', 'amortizedTransferCost', 'maxSlippagePct', 'alertThresholdPct'];
      for (const f of numFields) if (body[f] !== undefined) { const v = Number(body[f]); if (Number.isFinite(v) && v >= 0) { if (s[f] !== v) { changes.push(`${f}: ${s[f]} → ${v}`); s[f] = v; } } }
      if (Array.isArray(body.watchlist)) { changes.push('watchlist updated'); s.watchlist = body.watchlist.filter(x => typeof x === 'string').slice(0, 20); }
      if (body.venues && typeof body.venues === 'object') {
        for (const [v, cfg] of Object.entries(body.venues)) {
          if (s.venues[v] && cfg && typeof cfg === 'object' && 'enabled' in cfg) { s.venues[v] = { ...s.venues[v], enabled: bool(cfg.enabled) }; changes.push(`venue ${v} ${cfg.enabled ? 'enabled' : 'disabled'}`); }
        }
      }
      if (body.feeOverrides && typeof body.feeOverrides === 'object') { s.feeOverrides = sanitizeFeeOverrides(body.feeOverrides); changes.push('fee overrides updated'); }
      if (body.quoteEquivalence && typeof body.quoteEquivalence === 'object') {
        for (const k of ['USD', 'USDT', 'USDC']) if (body.quoteEquivalence[k] !== undefined) { const v = Number(body.quoteEquivalence[k]); if (Number.isFinite(v) && v > 0) s.quoteEquivalence[k] = v; }
        changes.push('quote equivalence updated');
      }
      // Mode switch — live requires explicit acknowledgement in the SAME request
      if (body.mode !== undefined && body.mode !== s.mode) {
        if (body.mode === 'live') {
          if (body.acknowledgeLive !== true) throw Object.assign(new Error('Enabling live trading requires acknowledgeLive=true and explicit user action.'), { statusCode: 400 });
          s.mode = 'live'; s.liveTradingAcknowledged = true; changes.push('MODE → LIVE (acknowledged by user)');
        } else if (body.mode === 'paper') { s.mode = 'paper'; s.liveTradingAcknowledged = false; changes.push('MODE → paper'); }
      }
    });
    if (changes.length) audit.log('config.update', { changes });
    res.json({ settings: publicSettings(store.get().settings), risk: riskStatus(store), changes });
  });

  // ---------- Credentials ----------
  router.get('/credentials', (req, res) => res.json({ credentials: vault.listCredentials(store) }));

  router.post('/credentials/:venue', async (req, res) => {
    const venue = req.params.venue;
    if (!LIVE_VENUES.includes(venue)) return res.status(400).json({ error: `Unknown venue "${venue}". Supported: ${LIVE_VENUES.join(', ')}` });
    const { apiKey, apiSecret, label, verify = true } = req.body || {};
    if (!apiKey || !apiSecret || typeof apiKey !== 'string' || typeof apiSecret !== 'string') return res.status(400).json({ error: 'apiKey and apiSecret are required. Request trading-only permissions — never withdrawal.' });
    if (String(apiKey).length < 8 || String(apiSecret).length < 8) return res.status(400).json({ error: 'Key or secret looks too short — refusing to store malformed credentials.' });
    if (verify) {
      const connector = ctx.connectorsById[venue];
      try {
        await connector.getBalances({ apiKey, apiSecret });
      } catch (e) {
        audit.log('credentials.verify_failed', { venue, error: e.message });
        return res.status(400).json({ error: `Could not verify credentials with ${venue}: ${e.message}. Credentials were NOT stored. If the exchange is unreachable from this host, retry with verify=false only if you understand the risk.` });
      }
    }
    vault.storeCredential(store, venue, { apiKey, apiSecret, label });
    audit.log('credentials.added', { venue, label: label || venue, keyHint: '…' + String(apiKey).slice(-4), verified: !!verify });
    res.json({ ok: true, venue, keyHint: '…' + String(apiKey).slice(-4) });
  });

  router.delete('/credentials/:venue', (req, res) => {
    const venue = req.params.venue;
    vault.removeCredential(store, venue);
    audit.log('credentials.removed', { venue });
    res.json({ ok: true });
  });

  // ---------- Balances ----------
  router.get('/balances', async (req, res) => {
    const paper = store.get().paperBalances;
    const live = {};
    for (const venue of LIVE_VENUES) {
      const creds = vault.readCredential(store, venue);
      if (!creds) continue;
      try { live[venue] = await ctx.connectorsById[venue].getBalances(creds); }
      catch (e) { live[venue] = { error: e.message }; }
    }
    res.json({ paper, live, note: 'Paper balances are simulated. Live balances are read-only queries against the exchange; no funds are moved by this app.' });
  });

  // ---------- Orders ----------
  router.get('/orders', (req, res) => {
    const orders = store.get().orders.slice().reverse().slice(0, 200);
    res.json({ orders, killSwitch: store.get().killSwitch });
  });
  router.post('/orders/:id/cancel', async (req, res) => {
    try { res.json({ order: await trading.cancelOrder(req.params.id) }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ---------- Trade flow ----------
  router.post('/preview', (req, res) => {
    try {
      const { buyVenue, sellVenue, baseAsset, notionalUSD } = req.body || {};
      if (!buyVenue || !sellVenue || !baseAsset) return res.status(400).json({ error: 'buyVenue, sellVenue and baseAsset are required' });
      const ticket = trading.createPreview({ buyVenue, sellVenue, baseAsset, notionalUSD: notionalUSD ? Number(notionalUSD) : undefined });
      res.json({ preview: ticket });
    } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
  });
  router.get('/preview/:id', (req, res) => {
    const p = trading.getPreview(req.params.id);
    if (!p) return res.status(404).json({ error: 'Preview not found or expired' });
    res.json({ preview: p });
  });
  router.post('/preview/:id/confirm', async (req, res) => {
    try { res.json(await trading.confirmPreview(req.params.id)); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message, riskCheck: e.riskCheck }); }
  });

  // ---------- Kill switch ----------
  router.post('/kill-switch', async (req, res) => {
    try {
      const engaged = !!(req.body && req.body.engaged);
      const summary = await trading.engageKillSwitch(engaged, req.body && req.body.reason);
      res.json({ killSwitch: store.get().killSwitch, ...summary });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Paper reset ----------
  router.post('/paper/reset', (req, res) => {
    audit.log('paper.reset', {});
    res.json({ paperBalances: trading.paper.reset() });
  });

  // ---------- Audit & risk ----------
  router.get('/audit', (req, res) => res.json({ entries: audit.list(Math.min(Number(req.query.limit) || 200, 1000)) }));
  router.get('/risk', (req, res) => res.json({ risk: riskStatus(store) }));

  // ---------- SSE stream ----------
  router.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders && res.flushHeaders();
    const send = () => {
      try {
        const opps = computeOpportunities();
        const s = store.get().settings;
        const risk = riskStatus(store);
        const payload = {
          ts: new Date().toISOString(),
          opportunities: opps.slice(0, 30),
          actionable: opps.filter(o => !o.stale && o.netPnlUSD > 0 && o.netReturnPct * 100 >= s.minNetReturnBps).length,
          health: marketData.snapshot().health,
          risk,
        };
        res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); }
    };
    send();
    const unsubscribe = marketData.onUpdate(() => send());
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); unsubscribe(); });
  });

  return router;
}

function withdrawalFeeMap() { const out = {}; for (const a of ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'USDT', 'USDC']) out[a] = withdrawalFee(a); return out; }
function delayMap() { const out = {}; for (const a of ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'USDT', 'USDC']) out[a] = transferDelayMin(a); return out; }
function sanitizeFeeOverrides(input) {
  const out = {};
  for (const [v, o] of Object.entries(input || {})) {
    if (!o || typeof o !== 'object') continue;
    const taker = Number(o.taker), maker = Number(o.maker);
    if (Number.isFinite(taker) && taker >= 0 && taker < 0.1) out[v] = { taker, maker: Number.isFinite(maker) && maker >= 0 && maker < 0.1 ? maker : taker };
  }
  return out;
}
function publicSettings(s) { const { } = s; return JSON.parse(JSON.stringify(s)); }

module.exports = { buildRouter, SYMBOLS };
