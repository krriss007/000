import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { buildTitleIndex, enrichItems, itemKey } from '@shared/normalize.js';
import * as api from './api';

export interface Toast {
  id: number;
  kind: 'ok' | 'danger' | 'info';
  title: string;
  message?: string;
}

interface LoadingState {
  boot: boolean;
  catalog: boolean;
  library: boolean;
  account: boolean;
}

interface StoreValue {
  ready: boolean;
  mode: api.DataPathMode;
  backendUrl: string;
  health: api.Health | null;
  catalog: api.CatalogResponse | null;
  library: any | null;
  account: any;
  loading: LoadingState;
  errors: { catalog: string | null; library: string | null; boot: string | null };
  windows: string[];
  lastFetched: string | null;
  toasts: Toast[];
  refresh: (options?: { force?: boolean; silent?: boolean }) => Promise<void>;
  setWindows: (windows: string[]) => Promise<void>;
  signIn: (mnemonic: string) => Promise<void>;
  createAccount: () => Promise<string | null>;
  signOut: () => Promise<void>;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

const DEFAULT_WINDOWS = ['daily', 'weekly'];
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<api.Health | null>(null);
  const [catalog, setCatalog] = useState<api.CatalogResponse | null>(null);
  const [library, setLibrary] = useState<any | null>(null);
  const [account, setAccount] = useState<any>({ signedIn: false });
  const [windows, setWindowsState] = useState<string[]>(DEFAULT_WINDOWS);
  const [mode, setMode] = useState<api.DataPathMode>('server');
  const [backendUrl, setBackendUrl] = useState<string>('');
  const [loading, setLoading] = useState<LoadingState>({ boot: true, catalog: false, library: false, account: false });
  const [errors, setErrors] = useState<{ catalog: string | null; library: string | null; boot: string | null }>({
    catalog: null,
    library: null,
    boot: null,
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const booted = useRef(false);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), toast.kind === 'danger' ? 12000 : 6000);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), []);

  const loadLibraryIfSignedIn = useCallback(
    async (currentAccount: any, options: { force?: boolean } = {}) => {
      if (!currentAccount?.signedIn) {
        setLibrary(null);
        return;
      }
      setLoading((state) => ({ ...state, library: true }));
      try {
        const result = await api.apiLibrary({ force: options.force });
        setLibrary(result);
        setErrors((state) => ({ ...state, library: result?.signedIn ? null : null }));
      } catch (error: any) {
        setErrors((state) => ({ ...state, library: error?.message || 'Could not load your library' }));
        if (error?.code === 'APP_UNREACHABLE') setLibrary(null);
      } finally {
        setLoading((state) => ({ ...state, library: false }));
      }
    },
    []
  );

  const load = useCallback(
    async (options: { force?: boolean; silent?: boolean; windows?: string[] } = {}) => {
      const useWindows = options.windows || windows;
      if (!options.silent) setLoading((state) => ({ ...state, catalog: true }));
      try {
        const result = await api.apiCatalog({ force: options.force, windows: useWindows });
        setCatalog(result);
        setMode(api.getMode());
        setBackendUrl(api.getBackendUrl());
        setErrors((state) => ({ ...state, catalog: null }));
        const nextAccount = result.account || account;
        if (result.account) setAccount(result.account);
        await loadLibraryIfSignedIn(nextAccount, { force: options.force });
      } catch (error: any) {
        setErrors((state) => ({ ...state, catalog: error?.message || 'Could not load the catalog' }));
      } finally {
        setLoading((state) => ({ ...state, catalog: false }));
      }
    },
    [account, loadLibraryIfSignedIn, windows]
  );

  const bootstrap = useCallback(async () => {
    setLoading((state) => ({ ...state, boot: true }));
    try {
      const ping = await api.fetchHealth();
      setHealth(ping);
      setMode(ping.dataPath);
      setBackendUrl(ping.backend?.url || '');
      const session = ping.account?.signedIn ? ping.account : await api.apiSession().catch(() => ({ signedIn: false }));
      setAccount(session);
      await load({});
    } catch (error: any) {
      setErrors((state) => ({ ...state, boot: error?.message || 'Could not reach the application server' }));
    } finally {
      setLoading((state) => ({ ...state, boot: false }));
    }
  }, [load]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootstrap();
  }, [bootstrap]);

  // Keep the "last fetched" indicator honest while the app stays open.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = useCallback(
    async (options: { force?: boolean; silent?: boolean } = {}) => {
      await api.fetchHealth().then((ping) => {
        setHealth(ping);
        setMode(ping.dataPath);
        setBackendUrl(ping.backend?.url || '');
      }).catch(() => {});
      await load({ force: options.force ?? true, silent: options.silent });
    },
    [load]
  );

  const setWindows = useCallback(
    async (next: string[]) => {
      setWindowsState(next);
      await load({ force: true, windows: next });
    },
    [load]
  );

  const signIn = useCallback(
    async (mnemonic: string) => {
      setLoading((state) => ({ ...state, account: true }));
      try {
        const session = await api.apiLogin(mnemonic);
        setAccount(session);
        pushToast({ kind: 'ok', title: 'Signed in', message: session?.user?.nickname || session?.user?.namespace || 'Account linked' });
        await load({ force: true });
      } finally {
        setLoading((state) => ({ ...state, account: false }));
      }
    },
    [load, pushToast]
  );

  const createAccount = useCallback(async () => {
    setLoading((state) => ({ ...state, account: true }));
    try {
      const result = await api.apiRegister();
      setAccount(result);
      pushToast({ kind: 'ok', title: 'Account created', message: 'Save the mnemonic shown next — it is the only key to this account.' });
      await load({ force: true });
      return result?.mnemonic || null;
    } finally {
      setLoading((state) => ({ ...state, account: false }));
    }
  }, [load, pushToast]);

  const signOut = useCallback(async () => {
    setLoading((state) => ({ ...state, account: true }));
    try {
      await api.apiLogout();
      setAccount({ signedIn: false });
      setLibrary(null);
      pushToast({ kind: 'ok', title: 'Signed out', message: 'The cached session token was removed and revoked on the backend.' });
    } finally {
      setLoading((state) => ({ ...state, account: false }));
    }
  }, [pushToast]);

  const lastFetched = catalog?.generatedAt || null;

  const value = useMemo<StoreValue>(
    () => ({
      ready: !loading.boot,
      mode,
      backendUrl,
      health,
      catalog,
      library,
      account,
      loading,
      errors,
      windows,
      lastFetched,
      toasts,
      refresh,
      setWindows,
      signIn,
      createAccount,
      signOut,
      pushToast,
      dismissToast,
    }),
    [
      account,
      backendUrl,
      catalog,
      dismissToast,
      errors,
      health,
      lastFetched,
      library,
      loading,
      mode,
      pushToast,
      refresh,
      setWindows,
      signIn,
      createAccount,
      signOut,
      toasts,
      windows,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used inside <StoreProvider>');
  return context;
}

/** Every title the app has loaded, plus a lookup index for search/detail. */
export function useAllItems() {
  const { catalog, library } = useStore();
  return useMemo(() => {
    const rows = [...(catalog?.rows || []), ...(library?.rows || [])];
    const flatSourced: any[] = [];
    for (const row of rows) {
      for (const item of row.items) flatSourced.push({ ...item, _row: { id: row.id, title: row.title, endpoint: row.endpoint }, _rowId: row.id });
    }
    const index = buildTitleIndex(flatSourced);
    const items = enrichItems(flatSourced, index);
    const byId = new Map<string, any>();
    for (const item of items) {
      const key = itemKey(item);
      if (key && !byId.has(key)) byId.set(key, item);
    }
    return { rows, items, index, byId };
  }, [catalog, library]);
}

export interface Facets {
  types: { value: string; count: number }[];
  genres: { value: string; count: number }[];
  decades: { value: string; count: number }[];
  providers: { value: string; count: number }[];
}

export function useFacets(): Facets {
  const { catalog } = useStore();
  const { items } = useAllItems();
  return useMemo(() => {
    const genreNames = new Map<number, string>();
    for (const genre of [...(catalog?.genres?.movies || []), ...(catalog?.genres?.shows || [])]) {
      genreNames.set(genre.id, genre.name);
    }
    const types = new Map<string, number>();
    const genres = new Map<string, number>();
    const decades = new Map<string, number>();
    const providers = new Map<string, number>();

    for (const item of items) {
      types.set(item.type, (types.get(item.type) || 0) + 1);
      for (const id of item.genreIds || []) {
        const name = genreNames.get(id);
        if (name) genres.set(name, (genres.get(name) || 0) + 1);
      }
      if (item.year) {
        const decade = `${Math.floor(item.year / 10) * 10}s`;
        decades.set(decade, (decades.get(decade) || 0) + 1);
      }
      for (const provider of item.facts?.providers || []) {
        providers.set(provider, (providers.get(provider) || 0) + 1);
      }
    }

    const toList = (map: Map<string, number>) =>
      [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);

    return {
      types: toList(types),
      genres: toList(genres).slice(0, 28),
      decades: toList(decades).sort((a, b) => a.value.localeCompare(b.value)),
      providers: toList(providers),
    };
  }, [catalog, items]);
}

export function useSearch(query: string) {
  const { items } = useAllItems();
  return useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const tokens = needle.split(/\s+/).filter(Boolean);
    const scored: { item: any; score: number }[] = [];

    for (const item of items) {
      const title = (item.title || '').toLowerCase();
      const haystack = [title, String(item.year || ''), item.type, item.tmdbId, item.episodeLabel, (item.overview || '').toLowerCase(), ...(item.facts?.providers || [])]
        .join(' ')
        .toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      let score = 0;
      if (title === needle) score += 100;
      if (title.startsWith(needle)) score += 50;
      if (title.includes(needle)) score += 25;
      if (String(item.tmdbId) === needle) score += 40;
      score += Math.min(10, (item.rating || 0) / 1);
      scored.push({ item, score });
    }

    return scored.sort((a, b) => b.score - a.score || (a.item.title || '').localeCompare(b.item.title || '')).map((entry) => entry.item);
  }, [items, query]);
}
