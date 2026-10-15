import React, { useCallback, useEffect, useState } from 'react';
import { RECON_DATE, KNOWN_GAPS, ROUTE_TABLE } from '@shared/route-table.js';
import * as api from '../lib/api';
import { absoluteTime, formatNumber, relativeTime } from '../lib/format';
import { useStore } from '../lib/store';
import { CardGrid } from '../components/Card';
import { AlertIcon, CheckIcon, DatabaseIcon, InfoIcon, RefreshIcon } from '../components/Icons';
import { Note, Pill, Spinner, StatusPill, UpdatedPill } from '../components/primitives';

function VerificationBadge({ verification }: { verification: string }) {
  if (verification === 'live') return <Pill tone="ok">live GET</Pill>;
  if (verification === 'source') return <Pill>source-verified</Pill>;
  return <Pill tone="danger">not deployed</Pill>;
}

export function Backend({ onOpen }: { onOpen: (item: any) => void }) {
  const { catalog, health, mode, backendUrl, windows, setWindows, refresh, account } = useStore();
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listId, setListId] = useState('');
  const [listResult, setListResult] = useState<any>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const loadOverview = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.apiOverview({ force, windows });
        setOverview(result);
      } catch (caught: any) {
        setError(caught?.message || 'Could not read the backend status');
      } finally {
        setLoading(false);
      }
    },
    [windows]
  );

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview]);

  const lookupList = async () => {
    const id = listId.trim();
    if (!id) return;
    setListLoading(true);
    setListError(null);
    setListResult(null);
    try {
      const result = await api.apiPublicList(id);
      setListResult(result);
    } catch (caught: any) {
      setListError(caught?.message || 'Could not load that list');
    } finally {
      setListLoading(false);
    }
  };

  const sourceRows = [
    ...(catalog?.sources || []).map((source: any) => ({ ...source, group: 'catalog' })),
    ...(overview?.sources || []).map((source: any) => ({ ...source, group: 'status' })),
  ].filter((source, index, all) => all.findIndex((entry) => entry.endpoint === source.endpoint) === index);

  const providerRows = overview?.providers?.weekly?.length ? overview.providers.weekly : overview?.providers?.daily || [];
  const trendingWindow = overview?.trending?.weekly?.length ? 'weekly' : 'daily';
  const trendingRows = overview?.trending?.[trendingWindow] || [];

  return (
    <div>
      <div className="page-head">
        <h1>Backend</h1>
        <p>
          What this app actually reads from the Aether API, what it is allowed to read, and how fresh each dataset is. Recon performed{' '}
          {RECON_DATE}; every route below is either observed live or read from the deployment&apos;s own source.
        </p>
      </div>

      <div className="section stack" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">
              <DatabaseIcon size={15} /> Connection
            </h2>
            <span className="spacer" />
            <button className="btn btn--sm" onClick={() => void loadOverview(true)} disabled={loading}>
              {loading ? <Spinner /> : <RefreshIcon size={14} />} Re-read status
            </button>
            <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
              Force catalog refresh
            </button>
          </div>

          <div className="facts">
            <div className="fact">
              <div className="fact__label">Backend URL</div>
              <div className="fact__value mono" style={{ fontSize: 12.5 }}>
                {backendUrl || health?.backend?.url || 'https://backend.aether.cx'}
                <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>
                  {health?.backend?.urlConfiguredViaEnv ? 'from AETHER_BACKEND_URL' : 'default (configurable via AETHER_BACKEND_URL)'}
                </span>
              </div>
            </div>
            <div className="fact">
              <div className="fact__label">Data path</div>
              <div className="fact__value">
                {mode === 'direct' ? 'direct (browser → backend)' : 'server (app server → backend)'}
              </div>
            </div>
            <div className="fact">
              <div className="fact__label">Server reachability</div>
              <div className="fact__value">
                {health?.serverPath?.reachable ? 'ok' : 'blocked'}{' '}
                {health?.serverPath?.checkedAt ? <span style={{ color: 'var(--muted)', fontSize: 11 }}>{relativeTime(health.serverPath.checkedAt)}</span> : null}
              </div>
            </div>
            <div className="fact">
              <div className="fact__label">Backend meta</div>
              <div className="fact__value">
                {overview?.meta?.name || '—'}
                {overview?.meta?.version ? <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>v{overview.meta.version}</span> : null}
              </div>
            </div>
            <div className="fact">
              <div className="fact__label">Captcha on backend</div>
              <div className="fact__value">{overview?.meta ? (overview.meta.hasCaptcha ? 'required' : 'not required') : '—'}</div>
            </div>
            <div className="fact">
              <div className="fact__label">Account</div>
              <div className="fact__value">
                {account?.signedIn ? `signed in (${account.method || 'login'})` : mode === 'direct' ? 'disabled in direct mode' : 'guest'}
              </div>
            </div>
          </div>

          {health?.serverPath?.reason ? (
            <div style={{ marginTop: 14 }}>
              <Note tone="warn" title="Why the fallback path is active" detail={health.serverPath.reason} />
            </div>
          ) : null}
          {error ? (
            <div style={{ marginTop: 14 }}>
              <Note tone="danger" title="Status read failed" detail={error} />
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Data freshness</h2>
            <span className="panel__hint">Every upstream call this app makes, with the timestamp of the last successful (or failed) fetch.</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>State</th>
                  <th>Items</th>
                  <th>Last fetched</th>
                  <th>Cache</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((source: any) => (
                  <tr key={`${source.group}-${source.endpoint}`}>
                    <td className="mono">{source.endpoint}</td>
                    <td>
                      <StatusPill ok={source.ok} status={source.status} />
                    </td>
                    <td className="num">{source.itemCount ?? '—'}</td>
                    <td>
                      {relativeTime(source.fetchedAt)}
                      <span style={{ display: 'block', color: 'var(--muted-2)', fontSize: 11 }}>{absoluteTime(source.fetchedAt)}</span>
                    </td>
                    <td className="num">
                      {source.ttlSeconds}s {source.cached ? <Pill>cached</Pill> : <Pill tone="accent">fresh</Pill>}
                    </td>
                    <td style={{ color: 'var(--text-2)', maxWidth: 420 }}>
                      {source.error ? <span style={{ color: 'var(--danger)' }}>{source.error}</span> : source.note || '—'}
                    </td>
                  </tr>
                ))}
                {!sourceRows.length ? (
                  <tr>
                    <td colSpan={6} style={{ color: 'var(--muted)' }}>
                      No requests recorded yet — hit “Force catalog refresh”.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid-2">
          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Provider health</h2>
              <span className="panel__hint">From mw_provider_status_count_{trendingWindow}</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Success</th>
                    <th>Failed</th>
                    <th>Not found</th>
                    <th>Success rate</th>
                  </tr>
                </thead>
                <tbody>
                  {providerRows.slice(0, 24).map((provider: any) => (
                    <tr key={provider.providerId}>
                      <td className="mono">{provider.providerId}</td>
                      <td className="num">{formatNumber(provider.success)}</td>
                      <td className="num">{formatNumber(provider.failed)}</td>
                      <td className="num">{formatNumber(provider.notfound)}</td>
                      <td>
                        <div className="cluster" style={{ gap: 8 }}>
                          <span className="bar" aria-hidden>
                            <span style={{ width: `${Math.round(provider.successRate * 100)}%` }} />
                          </span>
                          <span className="num">{(provider.successRate * 100).toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!providerRows.length ? (
                    <tr>
                      <td colSpan={5} style={{ color: 'var(--muted)' }}>
                        No provider counters returned.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Trending titles ({trendingWindow})</h2>
              <span className="panel__hint">Successful plays reported by the official apps</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Plays</th>
                    <th>Providers</th>
                  </tr>
                </thead>
                <tbody>
                  {trendingRows.slice(0, 20).map((entry: any, index: number) => (
                    <tr key={entry.fullId}>
                      <td className="num">{index + 1}</td>
                      <td>
                        {entry.title || <span style={{ color: 'var(--warn)' }}>id only</span>}
                        <span style={{ display: 'block', color: 'var(--muted-2)', fontSize: 11 }} className="mono">
                          {entry.fullId}
                        </span>
                      </td>
                      <td>{entry.type === 'show' ? 'TV' : entry.type === 'movie' ? 'Movie' : '—'}</td>
                      <td className="num">{formatNumber(entry.watched)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {(entry.providers || []).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                  {!trendingRows.length ? (
                    <tr>
                      <td colSpan={5} style={{ color: 'var(--muted)' }}>
                        No watch counters in this window.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Metric windows</h2>
            <span className="spacer" />
            {['daily', 'weekly', 'monthly'].map((window) => (
              <button
                key={window}
                className={`pill pill--button ${windows.includes(window) ? 'pill--active' : ''}`}
                onClick={() => {
                  const next = windows.includes(window) ? windows.filter((entry) => entry !== window) : [...windows, window];
                  if (next.length) void setWindows(next);
                }}
              >
                {window}
              </button>
            ))}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Samples</th>
                  <th>Metric families</th>
                  <th>Provider events</th>
                  <th>Referring hostnames</th>
                  <th>Users</th>
                  <th>Captcha solves</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(overview?.metricsSummary || {}).map(([window, summary]: [string, any]) => (
                  <tr key={window}>
                    <td className="mono">{window}</td>
                    <td className="num">{formatNumber(summary.samples)}</td>
                    <td className="num">{formatNumber(summary.metricFamilies)}</td>
                    <td className="num">{formatNumber(summary.plays)}</td>
                    <td className="num">{formatNumber(summary.hostnames)}</td>
                    <td className="num">{formatNumber(summary.users)}</td>
                    <td className="num">{formatNumber(summary.captcha)}</td>
                  </tr>
                ))}
                {!Object.keys(overview?.metricsSummary || {}).length ? (
                  <tr>
                    <td colSpan={7} style={{ color: 'var(--muted)' }}>
                      No metrics loaded.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="panel__hint" style={{ marginTop: 10 }}>
            The all-time <span className="mono">/metrics</span> dump is tens of megabytes, so this app never requests it — only the day/week/month
            windows, and the 30-day one only when you enable it.
          </p>
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Open a public list</h2>
            <span className="panel__hint">
              GET /lists/:id is the only public sharing mechanism. Private lists answer 403, so we surface that verbatim.
            </span>
          </div>
          <div className="cluster">
            <div className="field" style={{ flex: '1 1 320px' }}>
              <label htmlFor="list-id">List uuid</label>
              <input
                id="list-id"
                value={listId}
                placeholder="e.g. 6f1c9a2e-… (uuid owned by any account, marked public)"
                onChange={(event) => setListId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void lookupList();
                }}
              />
            </div>
            <button className="btn btn--primary" onClick={() => void lookupList()} disabled={listLoading || !listId.trim()}>
              {listLoading ? <Spinner /> : null} Load list
            </button>
          </div>

          {listError ? (
            <div style={{ marginTop: 12 }}>
              <Note tone="danger" title="That list could not be read" detail={listError} />
            </div>
          ) : null}

          {listResult?.list ? (
            <div style={{ marginTop: 14 }}>
              <div className="cluster" style={{ marginBottom: 10 }}>
                <strong>{listResult.list.name}</strong>
                <Pill tone={listResult.list.isPublic ? 'ok' : 'warn'}>{listResult.list.isPublic ? 'public' : 'private'}</Pill>
                <Pill>{listResult.list.items.length} items</Pill>
                <UpdatedPill at={listResult.source?.fetchedAt} />
              </div>
              {listResult.list.description ? <p className="panel__hint">{listResult.list.description}</p> : null}
              <Note
                tone="info"
                title="List items only carry a TMDB id"
                detail="The lists table stores tmdb_id + type; no title or artwork. Cards show the id and link to TMDB rather than inventing metadata."
              />
              <div style={{ marginTop: 12 }}>
                <CardGrid items={listResult.list.items} onOpen={onOpen} />
              </div>
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Backend route inventory</h2>
            <span className="panel__hint">
              Recon {RECON_DATE} · <Pill tone="ok">live GET</Pill> observed · <Pill>source-verified</Pill> POST-only ·{' '}
              <Pill tone="danger">not deployed</Pill>
            </span>
          </div>

          {ROUTE_TABLE.map((group) => (
            <div key={group.group} style={{ marginBottom: 18 }}>
              <div className="cluster" style={{ marginBottom: 8 }}>
                <strong>{group.group}</strong>
                {group.note ? <span className="panel__hint">{group.note}</span> : null}
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Path</th>
                      <th>Auth</th>
                      <th>Observed</th>
                      <th>Verification</th>
                      <th>Used here</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.routes.map((route) => (
                      <tr key={`${route.method}-${route.path}`}>
                        <td className="mono">{route.method}</td>
                        <td className="mono">{route.path}</td>
                        <td>{route.auth ? 'bearer' : 'public'}</td>
                        <td className="mono">{route.status}</td>
                        <td>
                          <VerificationBadge verification={route.verification} />
                        </td>
                        <td>
                          {route.used ? (
                            <span className="cluster" style={{ gap: 6, color: 'var(--ok)' }}>
                              <CheckIcon size={14} /> yes
                            </span>
                          ) : (
                            <span style={{ color: 'var(--muted)' }}>no</span>
                          )}
                        </td>
                        <td style={{ color: 'var(--text-2)', maxWidth: 460 }}>{route.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">
              <AlertIcon size={15} /> Access limitations this app respects
            </h2>
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.75 }}>
            {KNOWN_GAPS.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
          <div style={{ marginTop: 14 }}>
            <Note
              tone="info"
              title="Rate-limit behaviour"
              detail={`No rate-limit middleware exists in the backend source, but Cloudflare fronts it and the instance is shared. This app adds per-route throttling, TTL caching (catalog ${catalog?.sources?.[0]?.ttlSeconds ?? 300}s / metrics ${
                catalog?.sources?.find((source: any) => source.endpoint.startsWith('/metrics'))?.ttlSeconds ?? 120
              }s), request coalescing, honours Retry-After and backs off on 429/5xx. The app itself also limits each client to ${
                health?.rateLimit?.appRequestsPerMinute ?? 180
              } requests/minute.`}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">
              <InfoIcon size={15} /> Server-side cache
            </h2>
            <span className="panel__hint">What the app has fetched upstream so far</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Cache key</th>
                  <th>Fetched</th>
                  <th>Age</th>
                  <th>TTL</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {(health?.cache || []).map((entry) => (
                  <tr key={entry.key}>
                    <td className="mono">{entry.key}</td>
                    <td>{absoluteTime(entry.fetchedAt)}</td>
                    <td className="num">{Math.round(entry.ageMs / 1000)}s</td>
                    <td className="num">{entry.ttlSeconds}s</td>
                    <td>{entry.stale ? <Pill tone="warn">stale</Pill> : <Pill tone="ok">fresh</Pill>}</td>
                  </tr>
                ))}
                {!health?.cache?.length ? (
                  <tr>
                    <td colSpan={5} style={{ color: 'var(--muted)' }}>
                      Nothing cached yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
