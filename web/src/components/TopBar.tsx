import React, { useEffect, useState } from 'react';
import { navigate, routeHref, useRoute } from '../lib/router';
import { relativeTime } from '../lib/format';
import { useStore } from '../lib/store';
import { CloseIcon, DatabaseIcon, RefreshIcon, SearchIcon, UserIcon } from './Icons';
import { Pill, Spinner } from './primitives';

export function TopBar({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { catalog, account, loading, refresh, mode } = useStore();
  const route = useRoute();
  const [solid, setSolid] = useState(false);
  const [query, setQuery] = useState(route.name === 'search' ? route.query.get('q') || '' : '');

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (route.name === 'search') setQuery(route.query.get('q') || '');
    else setQuery('');
  }, [route.name, route.query]);

  const onSearchChange = (value: string) => {
    setQuery(value);
    const target = routeHref('search') + (value ? `?q=${encodeURIComponent(value)}` : '');
    if (route.name === 'search') navigate(target, { replace: true });
    else if (value) navigate(target, { replace: true });
  };

  const busy = loading.catalog;

  return (
    <header className={`topbar ${solid ? 'topbar--solid' : ''}`}>
      <a className="brand" href="#/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
        <span className="brand__mark" />
        <span>
          Aether
          <span className="brand__sub" style={{ display: 'block', lineHeight: 1 }}>
            catalog
          </span>
        </span>
      </a>

      <nav className="nav" aria-label="Primary">
        <a className={`nav__link ${route.name === 'home' ? 'nav__link--active' : ''}`} href="#/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
          Browse
        </a>
        <a
          className={`nav__link ${route.name === 'library' ? 'nav__link--active' : ''}`}
          href="#/library"
          onClick={(event) => { event.preventDefault(); navigate('/library'); }}
        >
          My library
        </a>
        <a
          className={`nav__link ${route.name === 'backend' ? 'nav__link--active' : ''}`}
          href="#/backend"
          onClick={(event) => { event.preventDefault(); navigate('/backend'); }}
        >
          Backend
        </a>
      </nav>

      <div className="search" role="search">
        <span className="search__icon">
          <SearchIcon />
        </span>
        <input
          className="search__input"
          type="search"
          value={query}
          placeholder="Search loaded titles, years, TMDB ids…"
          aria-label="Search loaded catalog"
          onChange={(event) => onSearchChange(event.target.value)}
          onFocus={() => {
            if (route.name !== 'search') navigate('/search', { replace: true });
          }}
        />
        {query ? (
          <button className="search__clear" onClick={() => onSearchChange('')} aria-label="Clear search">
            <CloseIcon size={14} />
          </button>
        ) : null}
      </div>

      <div className="cluster" style={{ gap: 8 }}>
        {catalog?.generatedAt ? (
          <Pill className="mono" title="When this app last fetched data from the backend">
            {busy ? <Spinner /> : null} updated {relativeTime(catalog.generatedAt)}
          </Pill>
        ) : null}
        {mode === 'direct' ? (
          <Pill tone="warn" title="The app server cannot reach the backend from its network, so this browser fetches it directly">
            direct mode
          </Pill>
        ) : null}
        <button
          className="btn btn--icon"
          onClick={() => void refresh({ force: true })}
          disabled={busy}
          title="Fetch fresh data from the backend (bypasses the app's cache)"
          aria-label="Refresh data"
        >
          {busy ? <Spinner /> : <RefreshIcon />}
        </button>
        <button className="account-chip" onClick={onOpenAccount} title={account?.signedIn ? 'Account and session' : 'Sign in with a mnemonic'}>
          {account?.signedIn ? (
            <span
              className="avatar"
              style={{
                background: `linear-gradient(135deg, ${account.user?.profile?.colorA || '#7c5cff'}, ${account.user?.profile?.colorB || '#22d3ee'})`,
              }}
            >
              {(account.user?.nickname || account.user?.namespace || 'A').slice(0, 1)}
            </span>
          ) : (
            <span className="avatar" style={{ background: 'rgba(255,255,255,.12)' }}>
              <UserIcon size={14} />
            </span>
          )}
          <span className="nav" style={{ display: 'inline-flex' }}>
            {account?.signedIn ? account.user?.nickname || 'Account' : 'Sign in'}
          </span>
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  const { backendUrl, mode } = useStore();
  return (
    <footer className="footer">
      <span className="cluster" style={{ gap: 8 }}>
        <DatabaseIcon size={14} /> Backend: <span className="mono">{backendUrl || 'https://backend.aether.cx'}</span>
      </span>
      <span>
        Data path: <strong>{mode}</strong> {mode === 'direct' ? '(browser → backend)' : '(app server → backend)'}
      </span>
      <span className="spacer" />
      <span>Aether Catalog reads only public endpoints plus your own account data. Read-only: nothing here writes to your account.</span>
    </footer>
  );
}
