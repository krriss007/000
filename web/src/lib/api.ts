/**
 * Path-aware API client.
 *
 * `server` mode (default): everything goes through this app's own `/api/*`,
 *   where the backend URL, caching and account credentials live.
 * `direct` mode (fallback): the app server reported that it cannot reach the
 *   backend from its network, so the browser reads the very same public
 *   endpoints itself. Account endpoints are disabled in this mode on purpose —
 *   the mnemonic must never touch the browser.
 */

import { createAetherData, DEFAULT_BACKEND_URL, DEFAULT_WINDOWS } from '@shared/sources.js';
import { RECON_DATE, ROUTE_TABLE } from '@shared/route-table.js';
import { createBrowserTransport, transportCooldown } from './transport';

export type DataPathMode = 'server' | 'direct';

export class ApiError extends Error {
  code: string;
  status: number | null;
  payload: any;

  constructor(message: string, options: { code?: string; status?: number | null; payload?: any } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code || 'ERROR';
    this.status = options.status ?? null;
    this.payload = options.payload ?? null;
  }
}

let mode: DataPathMode = 'server';
let backendUrl = DEFAULT_BACKEND_URL;
let directClient: ReturnType<typeof createAetherData> | null = null;

export function getMode(): DataPathMode {
  return mode;
}

export function getBackendUrl(): string {
  return backendUrl;
}

export function setMode(next: DataPathMode, url?: string) {
  if (url) backendUrl = url.replace(/\/+$/, '');
  if (next === mode) return;
  mode = next;
  directClient = null;
}

function direct() {
  if (!directClient) {
    directClient = createAetherData({
      backendUrl,
      transport: createBrowserTransport({ baseUrl: backendUrl }),
      windows: DEFAULT_WINDOWS,
    });
  }
  return directClient;
}

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers || {}) },
    });
  } catch (error: any) {
    throw new ApiError(`The application server did not answer (${error?.message || 'network error'}).`, { code: 'APP_UNREACHABLE' });
  }

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.message || `Request failed with HTTP ${response.status}`, {
      code: payload?.code || `HTTP_${response.status}`,
      status: response.status,
      payload,
    });
  }
  return payload as T;
}

export interface Health {
  app: { name: string; version: string; generatedAt: string; uptimeSeconds: number; reconDate: string };
  backend: { url: string; urlConfiguredViaEnv: boolean; defaultUrl: string };
  dataPath: DataPathMode;
  serverPath: { used: boolean; reachable: boolean; checkedAt: string; lastError: string | null; reason: string | null };
  rateLimit: { cooldownActive: boolean; cooldownReason: string | null; appRequestsPerMinute: number };
  account: any;
  cache: { key: string; fetchedAt: string; ageMs: number; ttlSeconds: number; stale: boolean }[];
  metricsWindows: string[];
}

export async function fetchHealth(): Promise<Health> {
  const health = await jsonRequest<Health>('/api/health');
  setMode(health.dataPath === 'direct' ? 'direct' : 'server', health.backend?.url);
  return health;
}

/** Runs the server call, transparently retrying on the direct path. */
async function withDirectFallback<T>(serverCall: () => Promise<T>, directCall: () => Promise<T>): Promise<T> {
  if (mode === 'direct') return directCall();
  try {
    return await serverCall();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'SERVER_PATH_UNAVAILABLE') {
      setMode('direct', error.payload?.backendUrl);
      return directCall();
    }
    throw error;
  }
}

export interface CatalogResponse {
  ok: boolean;
  dataPath: DataPathMode;
  backendUrl: string;
  generatedAt: string;
  windows: string[];
  sources: any[];
  rows: any[];
  featured: any;
  genres: { movies: { id: number; name: string }[]; shows: { id: number; name: string }[] };
  trending: Record<string, any[]>;
  providers: Record<string, any[]>;
  metricsSummary: Record<string, any>;
  discoverNote: string | null;
  account?: any;
}

export async function apiCatalog(options: { force?: boolean; windows?: string[] } = {}): Promise<CatalogResponse> {
  const query = queryString({ force: options.force, windows: options.windows?.join(',') });
  return withDirectFallback(
    () => jsonRequest<CatalogResponse>(`/api/catalog${query}`),
    async () => {
      const result: any = await direct().loadCatalog({ force: options.force, windows: options.windows });
      return { ...result, dataPath: 'direct', backendUrl, account: { signedIn: false, reason: 'direct-mode' } };
    }
  );
}

export async function apiOverview(options: { force?: boolean; windows?: string[] } = {}): Promise<any> {
  const query = queryString({ force: options.force, windows: options.windows?.join(',') });
  return withDirectFallback(
    () => jsonRequest<any>(`/api/overview${query}`),
    async () => {
      const result: any = await direct().loadOverview({ force: options.force, windows: options.windows });
      return {
        ...result,
        dataPath: 'direct',
        account: { signedIn: false, reason: 'direct-mode' },
        routes: { reconDate: RECON_DATE, table: ROUTE_TABLE },
        rateLimit: transportCooldown(),
      };
    }
  );
}

export async function apiLibrary(options: { force?: boolean } = {}): Promise<any> {
  const query = queryString({ force: options.force });
  if (mode === 'direct') {
    return {
      signedIn: false,
      dataPath: 'direct',
      reason: 'direct-mode',
      message: 'Account data needs the server path: the mnemonic and session token are kept on the server and are never sent to the browser.',
    };
  }
  return jsonRequest<any>(`/api/library${query}`);
}

export async function apiSession(): Promise<any> {
  if (mode === 'direct') return { signedIn: false, reason: 'direct-mode' };
  return jsonRequest<any>('/api/auth/session');
}

function requireServerMode(): void {
  if (mode === 'direct') {
    throw new ApiError(
      'Sign-in is handled by the application server, which cannot currently reach the Aether backend. Account features are disabled in the browser fallback path so the mnemonic never leaves the server.',
      { code: 'ACCOUNT_UNAVAILABLE' }
    );
  }
}

export async function apiLogin(mnemonic: string): Promise<any> {
  requireServerMode();
  return jsonRequest<any>('/api/auth/login', { method: 'POST', body: JSON.stringify({ mnemonic }) });
}

export async function apiRegister(): Promise<any> {
  requireServerMode();
  return jsonRequest<any>('/api/auth/register', { method: 'POST', body: JSON.stringify({}) });
}

export async function apiLogout(): Promise<any> {
  requireServerMode();
  return jsonRequest<any>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
}

export async function apiPublicList(id: string): Promise<any> {
  const query = queryString({});
  return withDirectFallback(
    () => jsonRequest<any>(`/api/lists/${encodeURIComponent(id)}${query}`),
    async () => {
      const result: any = await direct().loadPublicList(id);
      if (!result.list) throw new ApiError(result.source?.error || 'List not available', { status: 404 });
      return { list: result.list, source: result.source, dataPath: 'direct' };
    }
  );
}
