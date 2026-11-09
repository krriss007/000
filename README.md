# ArbScope — Arbitrage Analysis & Execution Desk

**ArbScope is a professional crypto-arbitrage analysis and execution dashboard. It shows you the math behind cross-exchange arbitrage — and it is deliberately honest about how that math loses money in the real world.**

> ⚠️ **No profit is guaranteed. Arbitrage can and does lose money.** Price differences can disappear in milliseconds. Fees, slippage, latency, thin liquidity, transfer delays, stale quotes, partial fills and exchange outages routinely turn an apparent opportunity into a realized loss. ArbScope never hides this: every estimate is net of costs, every trade carries an explicit worst-case bound and a break-even move, and every screen tells you the edge is not a promise.

---

## Quick start

**Requirements:** Node.js ≥ 20 (developed on 22), npm. No database — state lives in `data/state.json` (atomic writes).

```bash
npm install
npm start                 # http://localhost:8787
# development (simulated markets, auto-reload):
npm run dev
# run the test suite (32 tests):
npm test
```

By default the app starts in **paper-trading mode** against **simulated markets** (`DATA_MODE=auto` out of the box: simulated venues always poll; real public APIs are attempted and visibly flagged when unreachable). Everything works with zero API keys.

### Enabling real market data

```bash
DATA_MODE=live npm start   # real public APIs only; failing venues are flagged, never silently faked
DATA_MODE=auto npm start   # real + simulated (default)
DATA_MODE=simulated npm start
```

Real public market-data endpoints are called with no credentials. If the host cannot reach an exchange, that venue is marked **DOWN** in the UI and its quotes are excluded from tradable opportunities.

### Enabling live trading (real money — do this deliberately)

1. Create API keys on the exchange with **spot read + spot trade permissions only**. **Never grant withdrawal permission.** ArbScope requests only what it needs and contains no withdrawal code path anywhere.
2. In **Configuration → API credentials**, paste the key/secret and store them. They are encrypted with AES-256-GCM (master key from `ARBSCOPE_MASTER_KEY`), never returned to the browser, never logged. By default ArbScope verifies the key by calling the exchange's account endpoint; if verification fails, the credentials are **not** stored.
3. In **Configuration → Trading mode**, enable live trading by typing the acknowledgement phrase. Live mode also requires per-trade notional and daily-loss limits to be set (defaults: $2,000 / $250).
4. Every live order still requires an explicit confirmation per order, after risk checks are re-run against **fresh** books.

```bash
# production: the vault master key is mandatory
export ARBSCOPE_MASTER_KEY=$(openssl rand -hex 32)
export NODE_ENV=production
npm start
```

---

## What ArbScope does

### Live market analysis
- Polls supported exchanges through their **official APIs** (Binance Spot REST, Kraken REST, Coinbase Exchange public market data) plus a high-fidelity **simulator** for development/demos.
- Displays live quotes, **order books with depth**, per-venue latency, feed source, and data timestamps on every number.
- Detects cross-market opportunities across all directed venue pairs and computes, **net of all costs**:
  - gross spread vs. effective fill prices from a **book walk** (slippage is priced, not assumed);
  - **taker fees on both legs** (standard retail tiers pre-filled, per-venue overrides supported);
  - **funding/carry** assumption (configurable bps);
  - **amortized transfer/rebalance cost** per round trip (pre-funded assumption — see below);
  - withdrawal fees and on-chain transfer delays are shown for the rebalance path;
  - **capital required** and quantity (capped by notional limit, depth, and a slippage guard);
  - **break-even adverse move** — how far price can go against you before the trade loses money;
  - assumptions list and warning flags (low liquidity, stale data, mixed quotes, analysis-only venues, simulated venues).
- Flags unsafe conditions and makes them **blocking**, not decorative: stale quotes (>10s by default), venue outages, rate limits, missing books, negative net edge, exceeded limits — all refuse execution, with reasons.

### Paper trading (default)
- Full execution flow against observed order books with slippage and fees applied: preview → explicit confirm → fills → balance updates → order records → realized P&L. Starting paper bankroll: $25,000 quote + base inventory per venue (sized to model a pre-funded arb desk).

### Real-money trading (deliberate opt-in)
- Live orders via official authenticated endpoints (Binance `POST /api/v3/order`, Kraken `AddOrder`; HMAC-signed, trade permission only). **Coinbase is analysis-only in this build** (its Advanced Trade API requires JWT/CDP keys, not implemented) — its opportunities are labeled and it cannot be used for live execution.
- Before any live order, a preview shows: venue(s), asset, side, quantity, order type, worst-case price/slippage limit, estimated fees, estimated net P&L, and the full list of pre-trade risk checks (per-trade cap, daily realized loss limit, open-position cap, kill switch, data freshness, venue capability, positive net edge).
- **Explicit per-order confirmation** is required. Previews are single-use, expire after 60 seconds, and are **re-validated against fresh books at confirm time** — if the edge vanished, execution is refused. (Watch a preview's net shrink between preview and confirm: that is the market, and that is the point.)
- **Kill switch** (top-right, always visible): engages an execution block and cancels every open order on connected live venues (paper orders are cancelled as records). Disengage requires the same deliberate UI action.
- **No automatic transfers between exchanges, ever.** The app shows you transfer fees and delays; moving funds is your manual responsibility. Spot arbitrage here assumes **pre-funded** accounts.
- Live two-leg execution is sequential and honest: leg 1 = market buy on the cheap venue; leg 2 = market sell **of the actually filled quantity** on the expensive venue. If leg 2 fails or under-fills, the app reports an **OPEN POSITION / hedge_required** condition loudly (audit + UI), and never auto-unwinds — you decide how to close it. Reconciliation polls the exchange for actual status, filled quantity, and fees after submission.

### Interface
Responsive dark dashboard: opportunity table with freshness indicators, detailed trade view (full fee/risk breakdown, assumptions, warnings, canvas price & depth charts), balances (paper/live read-only), orders & fills with cancel support, per-venue health cards, audit log viewer, and full configuration (assets, venues, limits, thresholds, watchlist, alert threshold). Estimated net-return alerts toast in-app above your threshold.

---

## Architecture

```
server/
  config.js        env-driven config; production requires ARBSCOPE_MASTER_KEY
  store.js         atomic JSON persistence (state.json) — swap for Postgres at scale
  vault.js         AES-256-GCM credential vault; secrets never leave the server
  audit.js         append-only audit log (ring-capped, secret-field redaction)
  fees.js          fee schedules, withdrawal fees, transfer delays (configurable)
  arbitrage.js     PURE math: book-walk, depth caps, net P&L, break-even, flags
  marketData.js    polling, per-venue health/latency/rate-limit tracking, staleness, price history
  risk.js          pre-trade gates (kill switch, limits, freshness, venue capability, net edge)
  trading.js       preview → confirm (re-validated) → execute (paper|live) → reconcile → kill switch
  paper.js         paper ledger (balances, pre-checks, fills, reset)
  exchanges/       official-API connectors: binance, kraken, coinbase (analysis-only), simulated
  routes.js        REST + SSE API (security headers, mutation rate-limit, no secrets returned)
public/            vanilla JS/CSS dashboard (no build step, no framework lock-in)
test/              node:test suites — arbitrage math, risk limits, vault, API failure paths, full paper flow
```

Data flow for every trade:
`poll → normalize book → evaluate opportunities (net of costs) → [user: preview] → risk checks → [user: explicit confirm] → re-fetch books, re-evaluate, re-check risk → execute legs → reconcile → audit`.

Key invariants:
- **Staleness is blocking.** A quote older than `STALE_AFTER_MS` (default 10s) cannot be traded; the UI shows STALE badges and the confirm path refuses.
- **Simulated is always labeled.** Every simulated book, opportunity, balance and venue card carries a SIMULATED/PAPER label. In `DATA_MODE=live`, simulated venues are not polled at all; failing real venues are shown as DOWN — data is never faked.
- **Credentials never touch the browser.** The frontend lists venue, label, key hint (`…last4`) and date only.
- **Every mutation is audited**: connections, config changes, previews, confirmations/rejections, fills, cancellations, kill-switch events.
- **No withdrawal code path exists in this repository.** API keys must not carry withdrawal permission.

## Running with real market data (deployment)

This app needs outbound HTTPS access to exchange APIs for live prices:
`api.binance.com`, `api.kraken.com`, `api.exchange.coinbase.com`. Restricted
sandboxes/firewalls will block these (they return connection errors and the
affected venues will show as DOWN — the app will never silently substitute fake
data when `DATA_MODE=live`).

```bash
# any normal VM / container host:
docker build -t arbscope .
docker run -e ARBSCOPE_MASTER_KEY=$(openssl rand -hex 32) -p 8787:8787 arbscope
# or without Docker:
npm ci --omit=dev && DATA_MODE=live npm start
```

Live public market data requires **no API keys**. Keys are only needed for live
order placement (Configuration → API credentials, trading-only, never withdrawal).

## Supported exchanges

| Venue | Market data | Live execution | Notes |
|---|---|---|---|
| Binance | ✅ public REST (`bookTicker`, `depth`) | ✅ Spot orders, HMAC-SHA256 | Standard 0.10%/0.10% taker/maker pre-filled |
| Kraken | ✅ public REST (`Ticker`, `Depth`) | ✅ Spot orders, HMAC-SHA512 | Starter tier 0.26%/0.16% pre-filled |
| Coinbase | ✅ public Exchange REST (`/products/{id}/book`) | ❌ analysis-only this build | Advanced Trade JWT execution not implemented; opportunities labeled |
| Simulated (`sim_binance/kraken/coinbase`) | ✅ built-in | ❌ paper only | Fee-accurate simulator with drift, dislocations, outages, latency spikes, forced-stale testing |

Symbol universe: BTC/ETH/SOL/XRP/ADA/DOGE vs USDT (and vs USD for Coinbase). USDT/USDC/USD are compared under a configurable parity table (default 1.0) and flagged as mixed-quote assumptions when used.

## Testing

`npm test` — 32 tests covering:
- **Arbitrage calculations**: VWAP book-walk, depth/slippage caps, fee deduction, transfer & funding carry, break-even, mixed-quote parity, cross-symbol grouping, self-pair exclusion, sorting.
- **Risk limits**: kill switch, per-trade notional cap, daily realized loss halt, open-position cap, stale-data refusal, negative-edge refusal, live-mode acknowledgement, venue capability, missing-book (outage) refusal.
- **Order validation & API failures**: venue outage flagging and exclusion, rate-limit surfacing, stale books never served as fresh, partial outage isolation.
- **Key trading flows**: preview → confirm → fills → balance deltas → orders → realized P&L → audit trail; single-use previews; TTL expiry; kill-switch blocking; rejection leaves zero side effects.
- **Vault**: AES-256-GCM round-trip, wrong-key failure, tamper detection, secret-field redaction in audit log.

Tests run against temporary data directories and a seeded simulator — **never** against live exchanges or live funds.

## Limitations & operational risks (read this)

1. **Leg risk.** Two legs are not atomic on real venues. If the sell leg fails after the buy fills, you hold inventory and have price risk — ArbScope surfaces this as `hedge_required` and leaves unwinding to you.
2. **Edge decay.** By the time your order lands, the spread you saw is often gone. Previews are re-validated at confirm; if net ≤ 0 or data is stale, execution is refused.
3. **Liquidity.** Size is capped by walked depth and a slippage guard; large orders move the market against you on one or both venues.
4. **Transfers.** Spot arb assumes pre-funded inventories. Rebalancing requires withdrawals/deposits with fees (shown in estimates) and delays from minutes to ~30+ minutes (BTC) — during which the market moves.
5. **Stablecoin parity** between USD/USDT/USDC is an assumption (default 1.0). A de-peg makes "arbitrage" a directional bet.
6. **Fees change by tier.** Default schedules are retail standard tiers; set your real tier via fee overrides or your net estimates will be wrong.
7. **Outages and rate limits** happen; the app fails closed (no trading), not open.
8. **Simulated mode** is for development only; its prices are not real markets.
9. **Market data ≠ executable quotes.** Observed top-of-book does not guarantee your order fills at those prices.
10. **Not financial advice; not a managed product; no warranty.** Crypto trading involves total loss risk. You are responsible for orders, keys, taxes, and compliance with your jurisdiction.

## Configuration reference

| Env var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | HTTP bind |
| `DATA_DIR` | `./data` | state.json location |
| `DATA_MODE` | `auto` | `simulated` \| `live` \| `auto` |
| `ARBSCOPE_MASTER_KEY` | — (ephemeral in dev) | 32-byte hex vault key; **required in production** |
| `POLL_INTERVAL_MS` | `3000` | market-data poll cadence |
| `STALE_AFTER_MS` | `10000` | quote age above which trading is refused |
| `FETCH_TIMEOUT_MS` | `6000` | outbound exchange API timeout |
| `PREVIEW_TTL_MS` | `60000` | single-use preview lifetime |

UI-set limits (audited): per-trade notional, daily realized loss, max open positions, slippage guard, min bps to flag actionable, funding bps, amortized transfer cost, alert threshold, watchlist, fee overrides, quote equivalence, per-venue enable/disable, paper/live mode.

## Security notes

- Credentials: AES-256-GCM encrypted at rest; master key from env; secrets never serialized to the client or logs (audit log redacts `*secret*`/`*key*`/`*token*` fields); verify-before-store by default; removal is one click and audited.
- HTTP: CSP (`default-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, no-referrer, permissions-policy; mutation endpoints rate-limited; JSON body capped at 256 KB; `X-Powered-By` disabled.
- Live trading is gated three deep: mode + acknowledgement → per-trade/daily limits → fresh-book re-validation at confirm, plus the kill switch at all times.

## License

MIT. See `LICENSE` if present; otherwise MIT by default.
