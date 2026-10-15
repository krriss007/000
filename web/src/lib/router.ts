import { useEffect, useState } from 'react';

export type RouteName = 'home' | 'browse' | 'search' | 'title' | 'library' | 'backend';

export type Route = {
  name: RouteName;
  path: string;
  segments: string[];
  query: URLSearchParams;
};

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(queryPart || '');
  const name = (segments[0] as RouteName) || 'home';
  const known: RouteName[] = ['home', 'browse', 'search', 'title', 'library', 'backend'];
  return {
    name: known.includes(name) ? name : 'home',
    path: pathPart || '/',
    segments: segments.slice(1),
    query,
  };
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`;
  if (options.replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (window.location.hash === target) return;
  window.location.hash = target;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    // keep the document title in sync with the view
    const label =
      route.name === 'home'
        ? 'Browse'
        : route.name === 'browse'
          ? route.segments[0] || 'Browse'
          : route.name === 'search'
            ? `Search${route.query.get('q') ? `: ${route.query.get('q')}` : ''}`
            : route.name === 'title'
              ? route.segments[0] || 'Title'
              : route.name === 'library'
                ? 'My library'
                : 'Backend';
    document.title = `Aether Catalog · ${label}`;
  }, [route]);

  return route;
}

export function routeHref(...parts: (string | number | undefined | null)[]): string {
  const clean = parts.filter((part) => part !== undefined && part !== null && part !== '').map((part) => encodeURIComponent(String(part)));
  return `#/${clean.join('/')}`;
}
