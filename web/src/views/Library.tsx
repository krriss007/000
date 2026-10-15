import React from 'react';
import { relativeTime } from '../lib/format';
import { useStore } from '../lib/store';
import { Row } from '../components/Row';
import { EmptyState, Note, Pill, SkeletonRow, UpdatedPill } from '../components/primitives';

export function Library({ onOpen, onOpenAccount }: { onOpen: (item: any) => void; onOpenAccount: () => void }) {
  const { account, library, loading, errors, mode, refresh } = useStore();

  if (mode === 'direct') {
    return (
      <div>
        <div className="page-head">
          <h1>My library</h1>
        </div>
        <div className="section">
          <Note
            tone="warn"
            title="Account data is unavailable in direct mode"
            detail="Your mnemonic and session token only ever live on the app server. Right now the server cannot reach the backend from its network, so the browser is fetching public data directly and account endpoints are intentionally switched off."
            actions={
              <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
                Retry server path
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (!account?.signedIn) {
    return (
      <div>
        <div className="page-head">
          <h1>My library</h1>
          <p>
            Aether accounts are mnemonic-based (no passwords). Sign in and the server will read your own <span className="mono">/users/:id</span>{' '}
            endpoints: continue watching, bookmarks, watch history, ratings, custom lists and active sessions.
          </p>
        </div>
        <div className="section">
          <EmptyState title="Not signed in">
            <div className="stack" style={{ alignItems: 'center', marginTop: 12 }}>
              <button className="btn btn--primary" onClick={onOpenAccount}>
                Sign in with a mnemonic
              </button>
              <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>
                Or set <span className="mono">AETHER_MNEMONIC</span> on the server to sign in automatically at boot.
              </span>
            </div>
          </EmptyState>
        </div>
      </div>
    );
  }

  const counts = library?.counts;

  return (
    <div>
      <div className="page-head">
        <h1>My library</h1>
        <p>
          Everything below comes from your own account endpoints. The backend only ever serves your user id, so nothing here is shared with other
          accounts.
        </p>
      </div>

      <div className="section">
        <div className="panel">
          <div className="panel__head">
            <span
              className="avatar"
              style={{
                width: 40,
                height: 40,
                fontSize: 17,
                background: `linear-gradient(135deg, ${account.user?.profile?.colorA || '#7c5cff'}, ${account.user?.profile?.colorB || '#22d3ee'})`,
              }}
            >
              {(account.user?.nickname || account.user?.namespace || 'A').slice(0, 1)}
            </span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{account.user?.nickname || 'Signed in'}</div>
              <div className="panel__hint mono" style={{ fontSize: 11.5 }}>
                {account.user?.id}
              </div>
            </div>
            <span className="spacer" />
            <div className="cluster" style={{ gap: 8 }}>
              <Pill tone="ok">session active</Pill>
              <button className="btn btn--sm" onClick={onOpenAccount}>
                Account details
              </button>
              <button className="btn btn--sm" onClick={() => void refresh({ force: true })}>
                Refresh library
              </button>
            </div>
          </div>

          <div className="facts">
            <div className="fact">
              <div className="fact__label">Continue watching</div>
              <div className="fact__value">{counts?.progress ?? 0} titles</div>
            </div>
            <div className="fact">
              <div className="fact__label">Bookmarks</div>
              <div className="fact__value">{counts?.bookmarks ?? 0} titles</div>
            </div>
            <div className="fact">
              <div className="fact__label">Watch history</div>
              <div className="fact__value">{counts?.history ?? 0} titles</div>
            </div>
            <div className="fact">
              <div className="fact__label">Ratings</div>
              <div className="fact__value">{counts?.ratings ?? 0}</div>
            </div>
            <div className="fact">
              <div className="fact__label">Custom lists</div>
              <div className="fact__value">{counts?.lists ?? 0}</div>
            </div>
            <div className="fact">
              <div className="fact__label">Fetched</div>
              <div className="fact__value">{library?.generatedAt ? relativeTime(library.generatedAt) : '—'}</div>
            </div>
          </div>
        </div>
      </div>

      {errors.library ? (
        <div className="section" style={{ marginTop: 16 }}>
          <Note tone="danger" title="Your library could not be loaded" detail={errors.library} />
        </div>
      ) : null}

      {library?.sources?.some((source: any) => !source.ok) ? (
        <div className="section" style={{ marginTop: 16 }}>
          <Note
            tone="warn"
            title="Some account endpoints failed"
            detail={library.sources
              .filter((source: any) => !source.ok)
              .map((source: any) => `${source.endpoint}: ${source.error || 'failed'}`)
              .join(' · ')}
          />
        </div>
      ) : null}

      {loading.library && !library ? <SkeletonRow /> : null}

      {(library?.rows || []).map((row: any) => (
        <Row key={row.id} row={row} onOpen={onOpen} />
      ))}

      {library && !library.rows?.length && !loading.library ? (
        <div className="section" style={{ marginTop: 16 }}>
          <EmptyState title="This account has no library data yet">
            The backend returned empty collections for progress, bookmarks, watch history, ratings and lists. Watch something in the official
            Aether app and it will show up here.
          </EmptyState>
        </div>
      ) : null}

      {library?.generatedAt ? (
        <div className="section" style={{ marginTop: 18 }}>
          <UpdatedPill at={library.generatedAt} prefix="library fetched" />
        </div>
      ) : null}
    </div>
  );
}
