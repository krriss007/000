import React from 'react';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Hero, HeroSkeleton } from '../components/Hero';
import { Row } from '../components/Row';
import { Note, SkeletonRow, UpdatedPill } from '../components/primitives';
import { CompassIcon, SparkIcon } from '../components/Icons';

const WINDOW_LABELS: Record<string, string> = {
  daily: '24 hours',
  weekly: '7 days',
  monthly: '30 days',
};

export function Home({ onOpen }: { onOpen: (item: any) => void }) {
  const { catalog, library, loading, errors, refresh, mode, health, account, windows, setWindows } = useStore();

  const hasData = Boolean(catalog?.rows?.length);
  const booting = loading.boot && !catalog;

  const libraryRows = (library?.rows || []).slice(0, 3);
  const catalogRows = catalog?.rows || [];

  const toggleWindow = (window: string) => {
    const next = windows.includes(window) ? windows.filter((entry) => entry !== window) : [...windows, window];
    if (!next.length) return;
    void setWindows(next);
  };

  return (
    <div>
      {mode === 'direct' ? (
        <div className="section section--tight" style={{ marginBottom: 14 }}>
          <Note
            tone="warn"
            title="Direct mode: this browser is talking to the backend itself"
            detail={
              health?.serverPath?.lastError
                ? `The app server reported: ${health.serverPath.lastError}`
                : 'The app server cannot reach the backend from its network, so requests fall back to the browser. The backend allows any origin (verified), but account features stay server-side and are disabled here.'
            }
            actions={
              <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
                Retry server path
              </button>
            }
          />
        </div>
      ) : null}

      {errors.catalog ? (
        <div className="section section--tight" style={{ marginBottom: 14 }}>
          <Note
            tone="danger"
            title="Could not load the catalog"
            detail={errors.catalog}
            actions={
              <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
                Try again
              </button>
            }
          />
        </div>
      ) : null}

      {booting ? (
        <>
          <HeroSkeleton />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow count={5} />
        </>
      ) : (
        <>
          {catalog?.featured ? <Hero item={catalog.featured} onOpen={onOpen} /> : null}

          {catalog && !catalog.featured ? (
            <div className="section section--tight" style={{ marginTop: 18, marginBottom: 10 }}>
              <Note
                tone="warn"
                title="No featured title yet"
                detail="The backend returned no rows that can be featured. This happens while /discover is failing and no other source has produced titles."
              />
            </div>
          ) : null}

          {catalog?.discoverNote ? (
            <div className="section section--tight" style={{ marginBottom: 14 }}>
              <Note
                tone="warn"
                title="The catalog endpoint /discover is failing"
                detail={`${catalog.discoverNote} — the rows below come from the endpoints that do answer (/metrics, /letterboxd, your account). Every refresh retries /discover automatically.`}
                actions={
                  <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
                    Retry /discover
                  </button>
                }
              />
            </div>
          ) : null}

          <div className="section section--tight" style={{ marginBottom: 8 }}>
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <div className="cluster" style={{ gap: 8 }}>
                <span className="panel__hint">
                  <SparkIcon size={14} /> Show trending windows:
                </span>
                {['daily', 'weekly', 'monthly'].map((window) => (
                  <button
                    key={window}
                    className={`pill pill--button ${windows.includes(window) ? 'pill--active' : ''}`}
                    onClick={() => toggleWindow(window)}
                    title={
                      window === 'monthly'
                        ? 'The 30-day dump is the largest payload — opt-in'
                        : `Include the ${WINDOW_LABELS[window]} window from /metrics/${window}`
                    }
                  >
                    {WINDOW_LABELS[window]}
                  </button>
                ))}
              </div>
              <div className="cluster" style={{ gap: 8 }}>
                {catalog?.generatedAt ? <UpdatedPill at={catalog.generatedAt} /> : null}
                {account?.signedIn ? (
                  <span className="pill pill--ok">signed in as {account.user?.nickname || 'you'}</span>
                ) : (
                  <span className="pill">browsing as guest</span>
                )}
              </div>
            </div>
          </div>

          {catalog?.sources?.length ? (
            <div className="section section--tight" style={{ marginBottom: 16 }}>
              <div className="cluster" style={{ gap: 6 }}>
                <span className="panel__hint">Sources behind these rows:</span>
                {catalog.sources.map((source: any) => {
                  const tone = !source.ok ? 'danger' : source.itemCount ? 'ok' : 'warn';
                  return (
                    <button
                      key={source.endpoint}
                      className={`pill pill--button ${tone === 'danger' ? 'pill--danger' : tone === 'warn' ? 'pill--warn' : ''}`}
                      onClick={() => navigate('/backend')}
                      title={source.error || source.note || `Fetched ${source.fetchedAt}`}
                    >
                      <span className="mono">{source.endpoint}</span>
                      <span style={{ opacity: 0.75 }}>
                        {source.ok ? `HTTP ${source.status}` : source.status ? `HTTP ${source.status}` : 'network error'}
                        {source.itemCount != null ? ` · ${source.itemCount} ${source.itemCount === 1 ? 'record' : 'records'}` : ''}
                      </span>
                    </button>
                  );
                })}
                <span className="panel__hint">— click for the full freshness table</span>
              </div>
            </div>
          ) : null}

          {libraryRows.length ? (
            <>
              {libraryRows.map((row: any) => (
                <Row key={row.id} row={row} onOpen={onOpen} />
              ))}
            </>
          ) : null}

          {catalogRows.map((row: any) => (
            <Row key={row.id} row={row} onOpen={onOpen} />
          ))}

          {!hasData && !loading.catalog ? (
            <div className="section">
              <Note
                tone="danger"
                title="Nothing to show yet"
                detail="No source returned titles. Check the Backend view for per-endpoint status, then try a forced refresh."
                actions={
                  <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
                    Force refresh
                  </button>
                }
              />
            </div>
          ) : null}

          {catalog?.genres && (catalog.genres.movies.length || catalog.genres.shows.length) ? (
            <div className="section" style={{ marginTop: 28 }}>
              <div className="panel">
                <div className="panel__head">
                  <h2 className="panel__title">
                    <CompassIcon size={15} /> Browse by genre
                  </h2>
                  <span className="panel__hint">Genres come from the backend&apos;s own TMDB genre lists (via /discover).</span>
                </div>
                <div className="tag-list">
                  {[...catalog.genres.movies, ...catalog.genres.shows]
                    .filter((genre, index, all) => all.findIndex((entry) => entry.id === genre.id) === index)
                    .map((genre) => (
                      <button
                        key={genre.id}
                        className="pill pill--button"
                        onClick={() => navigate(`/browse/all?genre=${encodeURIComponent(genre.name)}`)}
                      >
                        {genre.name}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
