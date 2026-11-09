'use strict';
/* ArbScope frontend — no frameworks, no secrets in the browser. All data from our own API. */
const state = {
  bootstrap: null,
  settings: null,
  risk: null,
  opportunities: [],
  selectedOpp: null,
  currentPreview: null,
  shownAlertIds: new Set(),
  sseFailures: 0,
  balanceTab: 'paper',
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtUsd = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(+n)) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(+n).toFixed(dp);
const fmtSignedUsd = (n) => (n >= 0 ? '+' : '-') + '$' + Math.abs(+n || 0).toFixed(2);
const fmtPct = (n, dp = 3) => (n >= 0 ? '+' : '') + (+n || 0).toFixed(dp) + '%';
const fmtQty = (n) => (+n || 0).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const timeAgo = (ts) => { if (!ts) return 'never'; const s = Math.max(0, Math.floor((Date.now() - ts) / 1000)); return s < 60 ? s + 's ago' : Math.floor(s / 60) + 'm ago'; };
const fmtClock = (iso) => iso ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) : '—';

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((body && body.error) || `HTTP ${res.status}`); e.riskCheck = body && body.riskCheck; throw e; }
  return body;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (kind === 'warn') el.style.borderColor = 'var(--amber)';
  if (kind === 'error') { el.style.borderColor = 'var(--red)'; el.style.borderLeftColor = 'var(--red)'; }
  if (kind === 'good') { el.style.borderColor = 'var(--green)'; el.style.borderLeftColor = 'var(--green)'; }
  $('#toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/* ============ bootstrap & settings ============ */
async function loadBootstrap() {
  state.bootstrap = await api('/bootstrap');
  state.settings = state.bootstrap.settings;
  fillSettingsForm(state.settings);
  renderVenueToggles();
  await refreshCredentials();
  updateModePill();
}
function publicSettings() { return state.settings; }
function fillSettingsForm(s) {
  if (!s) return;
  $('#setMaxNotional').value = s.maxTradeNotional;
  $('#setMaxDailyLoss').value = s.maxDailyLoss;
  $('#setMaxOpenPositions').value = s.maxOpenPositions;
  $('#setMaxSlippage').value = s.maxSlippagePct;
  $('#setMinBps').value = s.minNetReturnBps;
  $('#setFundingBps').value = s.fundingCostBps;
  $('#setTransferCost').value = s.amortizedTransferCost;
  $('#setAlertThreshold').value = s.alertThresholdPct;
  $('#setWatchlist').value = (s.watchlist || []).join(', ');
  $('#quoteUSD').value = s.quoteEquivalence && s.quoteEquivalence.USD;
  $('#quoteUSDT').value = s.quoteEquivalence && s.quoteEquivalence.USDT;
  $('#quoteUSDC').value = s.quoteEquivalence && s.quoteEquivalence.USDC;
}
function renderVenueToggles() {
  const b = state.bootstrap;
  const s = state.settings;
  const wrap = $('#venueToggles');
  wrap.innerHTML = '';
  for (const [id, cfg] of Object.entries(s.venues)) {
    const isSim = id.startsWith('sim_');
    const fee = (s.feeOverrides && s.feeOverrides[id] && s.feeOverrides[id].taker) ?? (b.feeSchedules[id] && b.feeSchedules[id].taker) ?? 0.002;
    const row = document.createElement('div');
    row.className = 'venue-row';
    row.innerHTML = `
      <label class="switch"><input type="checkbox" data-venue="${esc(id)}" ${cfg.enabled ? 'checked' : ''}/><span></span>
        <span><strong>${esc(id)}</strong> <span class="src-badge ${isSim ? 'sim' : 'live'}">${isSim ? 'SIMULATED' : 'LIVE FEED'}</span></span>
      </label>
      <label class="small" style="flex-direction:row;align-items:center;gap:6px">taker fee
        <input class="fee-input" type="number" min="0" step="0.0005" data-fee-venue="${esc(id)}" value="${esc(fee)}" />
      </label>`;
    wrap.appendChild(row);
  }
}
async function putSettings(body) {
  const res = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
  state.settings = res.settings; state.risk = res.risk;
  fillSettingsForm(state.settings);
  updateModePill();
  return res;
}
async function refreshCredentials() {
  try {
    const { credentials } = await api('/credentials');
    const wrap = $('#credentialList');
    const entries = Object.entries(credentials);
    wrap.innerHTML = entries.length ? '' : '<p class="card-note small">No credentials stored. Market data works without keys; live trading requires them.</p>';
    for (const [venue, c] of entries) {
      const div = document.createElement('div');
      div.className = 'cred-row';
      div.innerHTML = `<span><strong>${esc(venue)}</strong> <span class="mono muted">${esc(c.keyHint)}</span> — ${esc(c.label || '')} <span class="muted small">added ${esc(String(c.addedAt).slice(0, 10))}</span></span>`;
      const btn = document.createElement('button');
      btn.className = 'btn ghost small';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        await api('/credentials/' + encodeURIComponent(venue), { method: 'DELETE' });
        toast(`Credentials for ${venue} removed`, 'warn');
        refreshCredentials();
      });
      div.appendChild(btn);
      wrap.appendChild(div);
    }
  } catch (e) { console.error(e); }
}
function updateModePill() {
  const mode = state.settings && state.settings.mode;
  const pill = $('#modePill');
  $('#modePillText').textContent = mode === 'live' ? 'LIVE' : 'PAPER';
  pill.classList.toggle('live', mode === 'live');
  $('#liveModeNote').textContent = mode === 'live'
    ? 'LIVE TRADING IS ON. Real orders will be placed after confirmation. Per-trade and daily-loss limits apply.'
    : 'Live trading is OFF. No real orders can be placed.';
  $('#paperModeBtn').classList.toggle('active', mode !== 'live');
  $('#liveModeBtn').classList.toggle('active', mode === 'live');
  const engaged = state.risk && state.risk.killSwitch;
  const kb = $('#killSwitchBtn');
  kb.classList.toggle('engaged', !!engaged);
  kb.innerHTML = engaged ? '<span class="kill-icon">■</span> KILL SWITCH ENGAGED' : '<span class="kill-icon">■</span> KILL SWITCH';
}

/* ============ SSE stream ============ */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (ev) => {
    state.sseFailures = 0;
    try {
      const data = JSON.parse(ev.data);
      state.opportunities = data.opportunities || [];
      state.risk = data.risk;
      renderKPIs(data);
      renderOppTable();
      renderVenueHealth(data.health || []);
      updateModePill();
      maybeAlert(data.opportunities || []);
      $('#feedStatusText').textContent = 'live feed · updated ' + fmtClock(data.ts);
      $('#oppTimestamp').textContent = 'snapshot ' + fmtClock(data.ts);
    } catch (e) { console.error('bad snapshot', e); }
  });
  es.addEventListener('error', () => {
    state.sseFailures += 1;
    $('#feedStatusText').textContent = 'reconnecting…';
    if (state.sseFailures > 5) { es.close(); setTimeout(pollOnce, 2000); }
  });
}
async function pollOnce() {
  try {
    const data = await api('/opportunities');
    state.opportunities = data.opportunities || [];
    renderKPIs({ opportunities: state.opportunities, health: data.health, risk: state.risk, actionable: data.actionable, ts: data.ts });
    renderOppTable();
    renderVenueHealth(data.health || []);
    $('#feedStatusText').textContent = 'polled ' + fmtClock(data.ts);
  } catch (e) {
    $('#feedStatusText').textContent = 'feed error';
  } finally {
    setTimeout(pollOnce, 4000);
  }
}
function maybeAlert(opps) {
  const thr = (state.settings && state.settings.alertThresholdPct) || 0.35;
  for (const o of opps) {
    if (o.netReturnPct >= thr && !o.stale && !state.shownAlertIds.has(o.id + Math.floor(Date.now() / 60000))) {
      state.shownAlertIds.add(o.id + Math.floor(Date.now() / 60000));
      toast(`Opportunity above ${thr}%: ${o.baseAsset} ${o.buyVenue} → ${o.sellVenue} (est. ${fmtPct(o.netReturnPct, 2)} net). Edge can vanish — verify before acting.`, 'warn');
    }
  }
}

/* ============ KPIs ============ */
function renderKPIs(data) {
  const health = data.health || [];
  const okCount = health.filter(h => h.reachable === true).length;
  const actionable = data.actionable ?? 0;
  $('#kpiActionable').textContent = actionable;
  $('#kpiActionable').className = 'kpi-value ' + (actionable > 0 ? 'good' : '');
  $('#kpiVenues').textContent = `${okCount}`;
  $('#kpiVenues').className = 'kpi-value ' + (okCount === health.length && health.length ? 'good' : okCount === 0 ? 'bad' : 'warn');
  $('#kpiVenuesTotal').textContent = health.length;
  const risk = state.risk || data.risk;
  const pnl = risk ? risk.pnlTodayUSD : null;
  const pnlEl = $('#kpiPnl');
  pnlEl.textContent = pnl === null ? '—' : fmtSignedUsd(pnl);
  pnlEl.className = 'kpi-value ' + (pnl > 0 ? 'good' : pnl < 0 ? 'bad' : '');
  $('#kpiPnlNote').textContent = (state.settings && state.settings.mode === 'live') ? 'paper + live (live mode ON)' : 'paper mode';
  $('#kpiLossBudget').textContent = risk ? fmtUsd(risk.dailyLossRemainingUSD) : '—';
  $('#kpiLossBudget').className = 'kpi-value ' + (risk && risk.dailyLossRemainingUSD < 50 ? 'bad' : '');
  const staleCount = (data.opportunities || []).filter(o => o.stale).length;
  const freshCount = (data.opportunities || []).length - staleCount;
  $('#kpiStale').textContent = `${freshCount} fresh / ${staleCount} stale`;
  $('#kpiStale').className = 'kpi-value ' + (staleCount > freshCount ? 'warn' : '');
}

/* ============ opportunity table ============ */
function renderOppTable() {
  const onlyProfitable = $('#showOnlyProfitable').checked;
  const freshOnly = $('#showFreshOnly').checked;
  let rows = state.opportunities.filter(o => (!onlyProfitable || o.netPnlUSD > 0) && (!freshOnly || !o.stale));
  $('#oppCount').textContent = rows.length;
  const tbody = $('#oppTableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No matching opportunities right now. That is normal — edges appear and disappear in seconds. Fees, slippage and depth decide what is real.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 40).map((o, i) => {
    const netClass = o.netPnlUSD > 0 ? 'good' : 'bad';
    const sim = (String(o.source).includes('simulated')) ? '<span class="row-flag sim">SIM</span>' : '';
    const neg = o.netPnlUSD <= 0 ? '<span class="row-flag neg">NEG EDGE</span>' : '';
    const staleCls = o.stale ? 'stale' : '';
    const freshLabel = o.stale ? 'STALE' : timeAgo(o.bookTs);
    return `<tr data-idx="${i}" tabindex="0">
      <td>${esc(o.baseAsset)}${sim}${neg}</td>
      <td><span class="route-badge">${esc(o.buyVenue)} → ${esc(o.sellVenue)}</span></td>
      <td>${fmtQty(o.quantity)}</td>
      <td>${fmtUsd(o.notionalUSD, 0)}</td>
      <td>${fmtPct(o.grossSpreadPct, 3)}</td>
      <td class="warn">${fmtUsd(o.totalFeesUSD)}</td>
      <td class="${netClass}">${fmtSignedUsd(o.netPnlUSD)}</td>
      <td class="${netClass}">${fmtPct(o.netReturnPct, 3)}</td>
      <td>${o.breakEvenMovePct >= 0 ? '±' : ''}${(+o.breakEvenMovePct).toFixed(3)}%</td>
      <td><span class="freshness-dot"><span class="fresh-dot ${staleCls}"></span>${esc(freshLabel)}</span></td>
      <td><button class="review-btn" data-review="${i}">Review →</button></td>
    </tr>`;
  }).join('');
  // bind clicks
  tbody.querySelectorAll('tr[data-idx]').forEach(tr => {
    const o = rows[+tr.dataset.idx];
    tr.addEventListener('click', (e) => { e.stopPropagation(); openDetail(o); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(o); });
  });
  tbody.querySelectorAll('[data-review]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openDetail(rows[+btn.dataset.review]); });
  });
}

/* ============ detail modal ============ */
function openDetail(opp) {
  state.selectedOpp = opp;
  $('#detailTitle').textContent = `${opp.baseAsset} — buy ${opp.buyVenue} → sell ${opp.sellVenue}`;
  $('#detailRoute').textContent = `${opp.buySymbol} @ ${opp.buyVenue}  →  ${opp.sellSymbol} @ ${opp.sellVenue}  ·  source: ${opp.source}  ·  book age: ${timeAgo(opp.bookTs)}`;
  const cells = [
    ['Net P&L (est)', fmtSignedUsd(opp.netPnlUSD), opp.netPnlUSD >= 0 ? 'good' : 'bad'],
    ['Net return (est)', fmtPct(opp.netReturnPct, 4), opp.netReturnPct >= 0 ? 'good' : 'bad'],
    ['Break-even move', '±' + Math.abs(opp.breakEvenMovePct).toFixed(3) + '%', opp.breakEvenMovePct >= 0.2 ? 'good' : 'warn'],
    ['Capital required', fmtUsd(opp.capitalRequiredUSD), ''],
    ['Gross spread', fmtPct(opp.grossSpreadPct, 3), opp.grossSpreadPct >= 0 ? 'good' : 'bad'],
    ['Quantity', fmtQty(opp.quantity) + ' ' + opp.baseAsset, ''],
  ];
  $('#detailStats').innerHTML = cells.map(([k, v, cls]) => `<div class="stat-cell"><div class="k">${esc(k)}</div><div class="v ${esc(cls)}">${esc(v)}</div></div>`).join('');
  const rows = [
    ['Best ask (buy venue)', `${fmtUsd(opp.bestAskRaw, opp.bestAskRaw < 10 ? 4 : 2)} ${opp.buyQuote}`],
    ['Best bid (sell venue)', `${fmtUsd(opp.bestBidRaw, opp.bestBidRaw < 10 ? 4 : 2)} ${opp.sellQuote}`],
    ['Effective buy price (book-walk, USD)', fmtUsd(opp.effBuyPrice)],
    ['Effective sell price (book-walk, USD)', fmtUsd(opp.effSellPrice)],
    ['Notional', fmtUsd(opp.notionalUSD)],
    ['Buy fee (taker)', '−' + fmtUsd(opp.buyFeeUSD)],
    ['Sell fee (taker)', '−' + fmtUsd(opp.sellFeeUSD)],
    ['Funding / carry', '−' + fmtUsd(opp.fundingCostUSD)],
    ['Amortized transfer (round-trip)', '−' + fmtUsd(opp.amortizedTransferCostUSD)],
    ['Gross P&L', fmtSignedUsd(opp.grossPnlUSD)],
    ['Total capital required (incl. fees+funding)', fmtUsd(opp.capitalRequiredUSD)],
    ['Withdrawal fee (rebalance, base asset)', opp.withdrawalFeeBase != null ? `${opp.withdrawalFeeBase} ${opp.baseAsset}` : 'n/a (pre-funded)'],
    ['Transfer delay (rebalance)', opp.transferDelayMinutes != null ? `~${opp.transferDelayMinutes} min` : 'n/a (pre-funded)'],
  ];
  let html = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  html += `<tr class="total"><td>NET P&L (after everything)</td><td class="${opp.netPnlUSD >= 0 ? 'good' : 'bad'}">${fmtSignedUsd(opp.netPnlUSD)} (${fmtPct(opp.netReturnPct, 4)})</td></tr>`;
  $('#detailBreakdown').innerHTML = html;
  $('#detailAssumptions').innerHTML = (opp.assumptions || []).map(a => `<li>${esc(a)}</li>`).join('');
  const warnings = (opp.warnings || []).slice();
  if (opp.stale) warnings.unshift('STALE MARKET DATA — execution will be refused until data is fresh.');
  $('#detailWarnings').innerHTML = warnings.length ? warnings.map(w => `<li>${esc(w)}</li>`).join('') : '<li>None beyond the baseline assumption risks above.</li>';
  openModal('detailModal');
  loadCharts(opp);
}
async function loadCharts(opp) {
  // Price history (session ring buffers per venue)
  try {
    const [buyHist, sellHist] = await Promise.all([
      api(`/price-history?venue=${encodeURIComponent(opp.buyVenue)}&symbol=${encodeURIComponent(opp.buySymbol)}`),
      api(`/price-history?venue=${encodeURIComponent(opp.sellVenue)}&symbol=${encodeURIComponent(opp.sellSymbol)}`),
    ]);
    drawPriceChart($('#priceChart'), buyHist.points || [], sellHist.points || [], opp);
  } catch { drawNoData($('#priceChart'), 'price history unavailable'); }
  // Depth chart
  try {
    const { books } = await api(`/books?symbol=${encodeURIComponent(opp.buySymbol)}`);
    const buyBook = books[opp.buyVenue];
    const sellBooks = await api(`/books?symbol=${encodeURIComponent(opp.sellSymbol)}`);
    const sellBook = sellBooks.books[opp.sellVenue];
    drawDepthChart($('#depthChart'), buyBook, sellBook);
    $('#bookMeta').textContent = bookMeta(opp, buyBook, sellBook);
  } catch { drawNoData($('#depthChart'), 'order books unavailable'); }
}
function drawNoData(canvas, msg) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#8694ad'; ctx.font = '12px sans-serif'; ctx.fillText(msg, 16, canvas.height / 2);
}
function drawPriceChart(canvas, buyPts, sellPts, opp) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const series = [
    { pts: buyPts.map(p => p.mid), color: '#4f8cff', label: opp.buyVenue },
    { pts: sellPts.map(p => p.mid), color: '#2dd4a7', label: opp.sellVenue },
  ];
  const all = series.flatMap(s => s.pts);
  if (all.length < 2) { drawNoData(canvas, 'collecting price history… (fills in after a few polls)'); return; }
  const min = Math.min(...all), max = Math.max(...all), pad = (max - min) * 0.15 || max * 0.001;
  const y = (v) => H - 8 - ((v - (min - pad)) / ((max + pad) - (min - pad))) * (H - 30);
  const x = (i, n) => 10 + (i / (n - 1)) * (W - 20);
  ctx.strokeStyle = '#24304a'; ctx.lineWidth = 1;
  for (let g = 0; g < 4; g++) { const gy = 10 + g * ((H - 30) / 3); ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
  ctx.font = '10px monospace';
  for (const s of series) {
    if (s.pts.length < 2) continue;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.beginPath();
    s.pts.forEach((v, i) => { const px = x(i, s.pts.length), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  // legend
  let lx = 12;
  for (const s of series) { ctx.fillStyle = s.color; ctx.fillRect(lx, 4, 10, 3); ctx.fillStyle = '#c4cddd'; ctx.fillText(s.label, lx + 14, 9); lx += 16 + ctx.measureText(s.label).width + 14; }
  ctx.fillStyle = '#8694ad';
  ctx.fillText(`${max.toFixed(max < 10 ? 4 : 2)}`, W - 64, 12);
  ctx.fillText(`${min.toFixed(min < 10 ? 4 : 2)}`, W - 64, H - 2);
}
function drawDepthChart(canvas, buyBook, sellBook) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const asks = (buyBook && buyBook.asks || []).slice(0, 10);
  const bids = (sellBook && sellBook.bids || []).slice(0, 10);
  if (!asks.length && !bids.length) { drawNoData(canvas, 'order books unavailable (venue down or stale)'); return; }
  const maxCum = Math.max(1e-9, ...[asks, bids].map(l => l.reduce((s, x) => s + x[1], 0)));
  const halfW = W / 2 - 30;
  let cum = 0;
  ctx.font = '9px monospace';
  asks.forEach(([price, qty], i) => {
    cum += qty;
    const barW = (cum / maxCum) * halfW;
    const y = H - 24 - i * ((H - 34) / 10);
    ctx.fillStyle = 'rgba(255,93,115,.55)';
    ctx.fillRect(W - 10 - barW, y, barW, 10);
    if (i === 0) { ctx.fillStyle = '#ffb3bd'; ctx.fillText('ask ' + price.toFixed(price < 10 ? 4 : 2), W - 14 - barW - 80, y + 9); }
  });
  cum = 0;
  bids.forEach(([price, qty], i) => {
    cum += qty;
    const barW = (cum / maxCum) * halfW;
    const y = H - 24 - i * ((H - 34) / 10);
    ctx.fillStyle = 'rgba(45,212,167,.55)';
    ctx.fillRect(10, y, barW, 10);
    if (i === 0) { ctx.fillStyle = '#a7f3d0'; ctx.fillText('bid ' + price.toFixed(price < 10 ? 4 : 2), 10 + barW + 6, y + 9); }
  });
  ctx.fillStyle = '#8694ad';
  ctx.fillText('← bids (sell venue)', 10, H - 6);
  ctx.fillText('asks (buy venue) →', W - 118, H - 6);
}
function bookMeta(opp, buyBook, sellBook) {
  const f = (b, side) => b ? `${side} best: ${side === 'asks' ? 'ask' : 'bid'} ${b[side === 'asks' ? 'asks' : 'bids'][0]?.[0]} (${b[side === 'asks' ? 'asks' : 'bids'][0]?.[1]} size) · ${b.source || 'n/a'} · ${timeAgo(b.ts)}${b.stale ? ' · STALE' : ''}` : `${side} book missing`;
  return `BUY  ${f(buyBook, 'asks')}\nSELL ${f(sellBook, 'bids')}\nVenue capability: ${opp.buyVenue === 'coinbase' || opp.sellVenue === 'coinbase' ? 'coinbase = analysis-only (no live execution)' : 'binance/kraken = live-capable with keys'}`;
}

/* ============ preview & confirm ============ */
async function openPreview(opp) {
  $('#previewResult').className = 'preview-result hidden';
  $('#previewAck').checked = false;
  $('#confirmOrderBtn').disabled = true;
  $('#previewBody').innerHTML = '<p class="muted">Building preview from live books…</p>';
  $('#previewChecks').innerHTML = '';
  openModal('previewModal');
  try {
    const { preview } = await api('/preview', { method: 'POST', body: JSON.stringify({ buyVenue: opp.buyVenue, sellVenue: opp.sellVenue, baseAsset: opp.baseAsset, notionalUSD: opp.notionalUSD }) });
    state.currentPreview = preview;
    renderPreview(preview);
  } catch (e) {
    $('#previewBody').innerHTML = `<div class="preview-result err">Could not build preview: ${esc(e.message)}</div>`;
  }
}
function renderPreview(p) {
  const o = p.opportunity;
  $('#previewMeta').textContent = `${p.mode.toUpperCase()} · expires ${new Date(p.expiresAt).toLocaleTimeString()} · preview ${p.id}`;
  const legsHtml = p.legs.map(l => `
    <div class="leg">
      <div class="leg-head"><span>${l.role === 'buy' ? 'LEG 1 — BUY' : 'LEG 2 — SELL'} on ${esc(l.venue)}</span><span>${esc(l.type.toUpperCase())} · ${esc(l.symbol)}</span></div>
      <div class="leg-grid">
        <div><div class="k">Quantity</div>${fmtQty(l.quantity)}</div>
        <div><div class="k">Est. price (USD)</div>${fmtUsd(l.estPriceUSD)}</div>
        <div><div class="k">Worst case (USD)</div>${fmtUsd(l.worstCasePriceUSD)}</div>
        <div><div class="k">Est. fee</div>${fmtUsd(l.estFeeUSD)}</div>
      </div>
    </div>`).join('');
  $('#previewBody').innerHTML = `
    <div class="preview-legs">${legsHtml}</div>
    <table class="kv-table">
      <tr><td>Capital required (buy leg, incl. fees+funding)</td><td>${fmtUsd(p.totals.capitalRequiredUSD)}</td></tr>
      <tr><td>Estimated total fees (both legs)</td><td>${fmtUsd(p.totals.estFeesUSD)}</td></tr>
      <tr><td>Funding/carry assumption</td><td>${fmtUsd(p.totals.estFundingUSD)}</td></tr>
      <tr><td>Amortized transfer cost</td><td>${fmtUsd(p.totals.estTransferUSD)}</td></tr>
      <tr><td>Expected net P&amp;L (estimate, NOT guaranteed)</td><td class="${p.totals.estNetPnlUSD >= 0 ? 'good' : 'bad'}">${fmtSignedUsd(p.totals.estNetPnlUSD)} (${fmtPct(p.totals.estNetReturnPct, 4)})</td></tr>
      <tr><td>Break-even adverse move</td><td>±${Math.abs(p.totals.breakEvenMovePct).toFixed(3)}%</td></tr>
    </table>
    ${p.riskCheck.ok ? '<div class="preview-result ok">All pre-trade risk checks pass at preview time. They are re-run at the moment you confirm — if the market moved, execution will be refused.</div>' : '<div class="preview-result err">Risk checks FAIL: ' + esc(p.riskCheck.reasons.join(' | ')) + '</div>'}`;
  $('#previewChecks').innerHTML = (p.riskCheck.checks || []).map(c => `<li><span class="${c.ok ? 'ok' : 'fail'}">${c.ok ? '✓' : '✗'}</span><span><strong>${esc(c.name)}</strong> — ${esc(c.detail)}</span></li>`).join('');
  $('#confirmOrderBtn').textContent = p.mode === 'live' ? 'CONFIRM — PLACE REAL ORDERS' : 'Confirm & execute (paper)';
  $('#confirmOrderBtn').disabled = !p.riskCheck.ok;
  $('#previewAck').onchange = () => { $('#confirmOrderBtn').disabled = !p.riskCheck.ok || !$('#previewAck').checked; };
}

/* ============ balances & orders ============ */
async function refreshBalances() {
  try {
    const { paper, live } = await api('/balances');
    renderBalanceGrid($('#balancesPaper'), paper, true);
    const liveWrap = $('#balancesLive');
    const entries = Object.entries(live || {});
    if (!entries.length) liveWrap.innerHTML = '<p class="card-note">No live credentials stored. Add trading-only API keys in Configuration to see read-only balances.</p>';
    else renderBalanceGrid(liveWrap, live, false);
  } catch (e) { console.error(e); }
}
function renderBalanceGrid(wrap, balances, isPaper) {
  wrap.innerHTML = Object.entries(balances).map(([venue, bal]) => {
    if (bal && bal.error) return `<div class="bal-card"><h4>${esc(venue)} <span class="src-badge live">LIVE</span></h4><div class="venue-error">${esc(bal.error)}</div></div>`;
    const baseRows = Object.entries((bal && bal.base) || {}).filter(([, v]) => v > 0).map(([a, v]) => `<div class="bal-row"><span>${esc(a)}</span><span>${fmtQty(v)}</span></div>`).join('');
    const isSim = venue.startsWith('sim_');
    return `<div class="bal-card"><h4>${esc(venue)} <span class="src-badge ${isSim ? 'sim' : (isPaper ? 'sim' : 'live')}">${isSim || isPaper ? 'PAPER' : 'LIVE'}</span></h4>
      <div class="bal-row"><span><strong>USD</strong></span><span>${fmtUsd(bal.quote)}</span></div>${baseRows}</div>`;
  }).join('');
}
async function refreshOrders() {
  try {
    const { orders } = await api('/orders');
    const tbody = $('#ordersTableBody');
    if (!orders.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No orders yet — paper trades appear here.</td></tr>'; return; }
    tbody.innerHTML = orders.slice(0, 60).map(o => `<tr>
      <td>${esc(fmtClock(o.ts))}</td><td>${esc(o.venue)}</td><td>${esc(o.symbol || '')}</td>
      <td class="${o.side === 'buy' ? 'good' : 'warn'}">${esc(String(o.side).toUpperCase())}</td>
      <td>${fmtQty(o.quantity)}</td><td>${fmtQty(o.filledQty)}</td>
      <td>${o.avgFillPrice ? fmtUsd(o.avgFillPrice, o.avgFillPrice < 10 ? 4 : 2) : '—'}</td>
      <td>${fmtUsd(o.feeUSD || 0)}</td>
      <td>${statusPill(o.status)}</td>
      <td>${(o.status === 'open' || o.status === 'partial') ? `<button class="review-btn" data-cancel="${esc(o.id)}">Cancel</button>` : ''}</td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      try { await api(`/orders/${encodeURIComponent(b.dataset.cancel)}/cancel`, { method: 'POST' }); toast('Order cancelled', 'warn'); refreshOrders(); }
      catch (e) { toast('Cancel failed: ' + e.message, 'error'); }
    }));
  } catch (e) { console.error(e); }
}
function statusPill(s) {
  const cls = { filled: 'good', open: 'warn', partial: 'warn', rejected: 'bad', cancelled: '', unknown: 'bad', leg_failed: 'bad' }[s] || '';
  return `<span class="${cls}">${esc(String(s).toUpperCase())}</span>`;
}

/* ============ venue health & audit ============ */
function renderVenueHealth(health) {
  const wrap = $('#venueHealth');
  const s = state.settings;
  wrap.innerHTML = health.map(h => {
    const enabled = s && s.venues[h.venue] ? s.venues[h.venue].enabled !== false : true;
    const isSim = h.venue.startsWith('sim_');
    const notPolled = h.polling === false;
    const cls = !enabled || notPolled ? 'disabled' : h.reachable ? 'ok' : 'down';
    const statusLine = !enabled ? 'disabled in settings' : notPolled ? 'not polled in current DATA_MODE (credentials & live execution still available)' : h.reachable === null ? 'unknown' : h.reachable ? 'reachable' : 'DOWN / UNREACHABLE';
    return `<div class="venue-card ${cls}">
      <div class="venue-name"><span>${esc(h.name || h.venue)}</span><span class="src-badge ${isSim ? 'sim' : 'live'}">${isSim ? 'SIMULATED' : 'LIVE API'}</span></div>
      <div class="venue-meta">
        status: ${esc(statusLine)}<br/>
        last success: ${h.lastSuccessTs ? timeAgo(h.lastSuccessTs) : 'never'} · latency: ${h.latencyMs != null ? h.latencyMs + ' ms' : 'n/a'}<br/>
        consecutive errors: ${h.consecutiveErrors || 0}${h.rateLimited ? ' · <span class="warn">RATE LIMITED</span>' : ''}
      </div>
      ${h.lastError && !h.reachable ? `<div class="venue-error">⚠ ${esc(h.lastError)}</div>` : ''}
    </div>`;
  }).join('');
}
async function refreshAudit() {
  try {
    const { entries } = await api('/audit?limit=100');
    const wrap = $('#auditLog');
    wrap.innerHTML = entries.map(e => `<div class="audit-entry ${/kill_switch|hedge_required|leg_failed/.test(e.action) ? 'critical' : ''}"><span class="audit-time">${esc(new Date(e.ts).toLocaleString())}</span><span class="audit-action">${esc(e.action)}</span><span class="audit-detail">${esc(JSON.stringify(e.details))}</span></div>`).join('') || '<div class="muted">No audit entries yet.</div>';
  } catch (e) { console.error(e); }
}

/* ============ modals ============ */
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
$$('.modal-backdrop').forEach(bd => bd.addEventListener('click', (e) => { if (e.target === bd) bd.classList.add('hidden'); }));
$$('[data-close-modal]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.closeModal)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden')); });

/* ============ wire everything ============ */
$('#refreshBtn').addEventListener('click', async () => { await pollOpportunityNow(); });
async function pollOpportunityNow() {
  try { const data = await api('/opportunities'); state.opportunities = data.opportunities || []; renderOppTable(); renderVenueHealth(data.health || []); toast('Refreshed', 'good'); } catch (e) { toast('Refresh failed: ' + e.message, 'error'); }
}
$('#showOnlyProfitable').addEventListener('change', renderOppTable);
$('#showFreshOnly').addEventListener('change', renderOppTable);
$('#detailPreviewBtn').addEventListener('click', () => { if (state.selectedOpp) openPreview(state.selectedOpp); });

$('#confirmOrderBtn').addEventListener('click', async () => {
  const p = state.currentPreview; if (!p) return;
  $('#confirmOrderBtn').disabled = true;
  try {
    const result = await api(`/preview/${encodeURIComponent(p.id)}/confirm`, { method: 'POST' });
    const box = $('#previewResult');
    box.className = 'preview-result ' + (result.status === 'filled' ? 'ok' : result.status === 'rejected' || result.status === 'failed' ? 'err' : 'err');
    if (result.status === 'filled') box.innerHTML = `<strong>Filled (${esc(result.mode)}).</strong> ${result.quantity} units · est. net ${fmtSignedUsd(result.estNetPnlUSD || 0)}.<br/>Both legs executed. Refresh orders below.`;
    else if (result.status === 'hedge_required') box.innerHTML = `<strong>LEG FAILURE — OPEN POSITION.</strong><br/>${esc(result.legRisk || result.failReason)}`;
    else if (result.status === 'partial') box.innerHTML = `<strong>PARTIAL FILL.</strong><br/>${esc(result.legRisk || 'One leg filled more than the other — inspect balances immediately.')}`;
    else box.innerHTML = `<strong>${esc(String(result.status).toUpperCase())}</strong><br/>${esc((result.reasons || [result.failReason]).filter(Boolean).join(' | '))}`;
    toast('Execution result: ' + result.status, result.status === 'filled' ? 'good' : 'error');
    refreshOrders(); refreshBalances(); refreshAudit();
  } catch (e) {
    const box = $('#previewResult');
    box.className = 'preview-result err';
    box.innerHTML = `<strong>Execution refused.</strong><br/>${esc(e.message)}`;
    toast('Execution refused: ' + e.message, 'error');
    refreshAudit();
  }
});

// Balance tabs
$$('[data-balance-tab]').forEach(t => t.addEventListener('click', () => {
  state.balanceTab = t.dataset.balanceTab;
  $$('[data-balance-tab]').forEach(x => x.classList.toggle('active', x === t));
  $('#balancesPaper').classList.toggle('hidden', state.balanceTab !== 'paper');
  $('#balancesLive').classList.toggle('hidden', state.balanceTab !== 'live');
}));
$('#resetPaperBtn').addEventListener('click', async () => {
  if (!confirm('Reset paper balances and inventory to the default 25,000 USD + base stock per venue?')) return;
  await api('/paper/reset', { method: 'POST' });
  toast('Paper account reset', 'warn');
  refreshBalances();
});

// Kill switch
$('#killSwitchBtn').addEventListener('click', () => {
  const engaged = state.risk && state.risk.killSwitch;
  $('#killTitle').textContent = engaged ? 'Disengage kill switch' : 'Engage kill switch';
  $('#confirmKillBtn').textContent = engaged ? 'DISENGAGE — resume trading' : 'ENGAGE KILL SWITCH';
  $('#killResult').classList.add('hidden');
  $('#killReason').value = '';
  openModal('killModal');
});
$('#confirmKillBtn').addEventListener('click', async () => {
  const engaged = !(state.risk && state.risk.killSwitch);
  const btn = $('#confirmKillBtn');
  btn.disabled = true;
  try {
    const res = await api('/kill-switch', { method: 'POST', body: JSON.stringify({ engaged, reason: $('#killReason').value || 'user action' }) });
    state.risk = { ...(state.risk || {}), killSwitch: res.killSwitch };
    const box = $('#killResult');
    box.className = 'preview-result ' + (engaged ? 'err' : 'ok');
    box.innerHTML = engaged
      ? `<strong>Kill switch ENGAGED.</strong> New orders are blocked. Cancelled ${res.cancelled.length} open order(s)${res.failed.length ? `, ${res.failed.length} cancellation(s) FAILED — check exchange directly` : ''}.`
      : '<strong>Kill switch disengaged.</strong> Trading re-enabled. Limits still apply.';
    box.classList.remove('hidden');
    updateModePill(); refreshAudit(); refreshOrders();
    toast(engaged ? 'KILL SWITCH ENGAGED — orders blocked' : 'Kill switch disengaged', engaged ? 'error' : 'warn');
  } catch (e) { toast('Kill switch error: ' + e.message, 'error'); } finally { btn.disabled = false; }
});

// Risk limits save
$('#saveRiskBtn').addEventListener('click', async () => {
  try {
    await putSettings({
      maxTradeNotional: +$('#setMaxNotional').value,
      maxDailyLoss: +$('#setMaxDailyLoss').value,
      maxOpenPositions: +$('#setMaxOpenPositions').value,
      maxSlippagePct: +$('#setMaxSlippage').value,
      minNetReturnBps: +$('#setMinBps').value,
      fundingCostBps: +$('#setFundingBps').value,
      amortizedTransferCost: +$('#setTransferCost').value,
      alertThresholdPct: +$('#setAlertThreshold').value,
    });
    // venue toggles + fee overrides
    const venues = {}; const feeOverrides = {};
    $$('#venueToggles [data-venue]').forEach(cb => { venues[cb.dataset.venue] = { enabled: cb.checked }; });
    $$('#venueToggles [data-fee-venue]').forEach(inp => { const v = inp.dataset.feeVenue; feeOverrides[v] = feeOverrides[v] || {}; feeOverrides[v].taker = +inp.value; });
    await putSettings({ venues, feeOverrides });
    toast('Risk limits & venue config saved', 'good');
    refreshAudit();
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
});

// Watchlist & quotes
$('#saveWatchlistBtn').addEventListener('click', async () => {
  try {
    await putSettings({
      watchlist: $('#setWatchlist').value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
      quoteEquivalence: { USD: +$('#quoteUSD').value, USDT: +$('#quoteUSDT').value, USDC: +$('#quoteUSDC').value },
    });
    toast('Watchlist & quote equivalence saved', 'good');
    refreshAudit();
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
});

// Credentials
$('#credentialForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const venue = $('#credVenue').value;
  const payload = { apiKey: $('#credKey').value.trim(), apiSecret: $('#credSecret').value.trim(), label: $('#credLabel').value.trim(), verify: $('#credVerify').checked };
  if (!payload.apiKey || !payload.apiSecret) { toast('Both key and secret are required', 'error'); return; }
  try {
    const res = await api('/credentials/' + venue, { method: 'POST', body: JSON.stringify(payload) });
    toast(`Credentials stored encrypted for ${res.venue} (${res.keyHint})`, 'good');
    $('#credKey').value = ''; $('#credSecret').value = ''; $('#credLabel').value = '';
    refreshCredentials(); refreshAudit();
  } catch (err) { toast('Not stored: ' + err.message, 'error'); }
});

// Mode switching
$('#paperModeBtn').addEventListener('click', async () => {
  try { await putSettings({ mode: 'paper' }); toast('Paper mode — no real orders will be placed', 'good'); refreshAudit(); } catch (e) { toast(e.message, 'error'); }
});
$('#liveModeBtn').addEventListener('click', () => { $('#liveAckInput').value = ''; $('#confirmLiveAckBtn').disabled = true; openModal('liveAckModal'); });
$('#liveAckInput').addEventListener('input', (e) => { $('#confirmLiveAckBtn').disabled = e.target.value.trim() !== 'ENABLE LIVE TRADING'; });
$('#confirmLiveAckBtn').addEventListener('click', async () => {
  try {
    await putSettings({ mode: 'live', acknowledgeLive: true });
    closeModal('liveAckModal');
    toast('LIVE TRADING ENABLED. Real orders possible after confirmation. Limits apply.', 'error');
    refreshAudit();
  } catch (e) { toast(e.message, 'error'); }
});

$('#refreshAuditBtn').addEventListener('click', refreshAudit);

/* ============ boot ============ */
(async function init() {
  try {
    await loadBootstrap();
    await Promise.all([refreshBalances(), refreshOrders(), refreshAudit()]);
    connectStream();
    setInterval(() => { refreshOrders(); refreshBalances(); }, 6000);
    setInterval(refreshAudit, 8000);
  } catch (e) {
    toast('Failed to load: ' + e.message, 'error');
  }
})();
