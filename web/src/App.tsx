import React, { useEffect, useState } from 'react';
import { navigate, useRoute } from './lib/router';
import { useAllItems, useStore } from './lib/store';
import { Footer, TopBar } from './components/TopBar';
import { DetailSheet } from './components/DetailSheet';
import { AuthDialog } from './components/AuthDialog';
import { Note, Toasts } from './components/primitives';
import { Home } from './views/Home';
import { Browse } from './views/Browse';
import { Library } from './views/Library';
import { Backend } from './views/Backend';

export function App() {
  const route = useRoute();
  const { ready, errors } = useStore();
  const { byId, items } = useAllItems();
  const [accountOpen, setAccountOpen] = useState(false);

  const openTitle = (item: any) => {
    if (!item?.id) return;
    navigate(`/title/${encodeURIComponent(item.id)}`);
  };

  const selectedKey = route.name === 'title' ? route.segments[0] : null;
  const selected = selectedKey
    ? byId.get(selectedKey) || items.find((item: any) => item.tmdbId === selectedKey || item.id === selectedKey) || null
    : null;

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [route.path, route.query.toString()]);

  return (
    <div className="app">
      <TopBar onOpenAccount={() => setAccountOpen(true)} />

      <main className="app__main">
        {errors.boot ? (
          <div className="section" style={{ marginTop: 18 }}>
            <Note
              tone="danger"
              title="The application server is not answering"
              detail={`${errors.boot} — this page is served by the same server, so a reload is usually enough once it is back.`}
            />
          </div>
        ) : null}

        {route.name === 'home' ? <Home onOpen={openTitle} /> : null}
        {route.name === 'browse' ? <Browse variant="row" onOpen={openTitle} /> : null}
        {route.name === 'search' ? <Browse variant="search" onOpen={openTitle} /> : null}
        {route.name === 'library' ? <Library onOpen={openTitle} onOpenAccount={() => setAccountOpen(true)} /> : null}
        {route.name === 'backend' ? <Backend onOpen={openTitle} /> : null}

        {route.name === 'title' && !selected && ready ? (
          <div>
            <div className="page-head">
              <h1>Title not loaded</h1>
              <p>
                <span className="mono">{selectedKey}</span> is not part of the records currently loaded from the backend. It may have come from a row
                whose source is failing, or from a link created in another session.
              </p>
            </div>
            <div className="section">
              <Note
                tone="info"
                title="Nothing is fetched per-title"
                detail="The backend exposes no per-title endpoint, so a detail view can only show fields that already arrived inside a list payload."
              />
            </div>
          </div>
        ) : null}
      </main>

      {selected ? <DetailSheet item={selected} onClose={() => navigate('/', { replace: true })} onOpen={openTitle} /> : null}
      {accountOpen ? <AuthDialog onClose={() => setAccountOpen(false)} /> : null}
      <Toasts />
      <Footer />
    </div>
  );
}
