import React, { useMemo, useState } from 'react';
import { navigate, useRoute } from '../lib/router';
import { useAllItems, useFacets, useSearch, useStore } from '../lib/store';
import { CardGrid } from '../components/Card';
import { ChevronLeft, ChevronRight, SearchIcon } from '../components/Icons';
import { EmptyState, Note, Pill, SkeletonCard, UpdatedPill } from '../components/primitives';

const PAGE_SIZE = 24;

type SortKey = 'source' | 'rating' | 'year-desc' | 'year-asc' | 'title' | 'plays';

function applySort(items: any[], sort: SortKey) {
  const copy = [...items];
  switch (sort) {
    case 'rating':
      return copy.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    case 'year-desc':
      return copy.sort((a, b) => (b.year || 0) - (a.year || 0));
    case 'year-asc':
      return copy.sort((a, b) => (a.year || 0) - (b.year || 0));
    case 'title':
      return copy.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    case 'plays':
      return copy.sort((a, b) => (b.facts?.watched || 0) - (a.facts?.watched || 0));
    default:
      return copy;
  }
}

export function Browse({
  variant,
  onOpen,
}: {
  variant: 'row' | 'search';
  onOpen: (item: any) => void;
}) {
  const route = useRoute();
  const { catalog, library, loading } = useStore();
  const { items } = useAllItems();
  const facets = useFacets();

  const query = route.query.get('q') || '';
  const searchResults = useSearch(query);

  const rowId = variant === 'row' ? route.segments[0] || 'all' : null;
  const [filterType, setFilterType] = useState('');
  const [filterGenre, setFilterGenre] = useState(route.query.get('genre') || '');
  const [filterDecade, setFilterDecade] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [sort, setSort] = useState<SortKey>(variant === 'search' ? 'source' : 'source');

  React.useEffect(() => {
    setFilterGenre(route.query.get('genre') || '');
  }, [route.query]);

  const row = useMemo(() => {
    if (variant !== 'row') return null;
    return [...(catalog?.rows || []), ...(library?.rows || [])].find((entry: any) => entry.id === rowId) || null;
  }, [catalog, library, rowId, variant]);

  const base = useMemo(() => {
    if (variant === 'search') return searchResults;
    if (rowId === 'all' || !row) return items;
    return row.items;
  }, [items, row, rowId, searchResults, variant]);

  const genreNameToId = useMemo(() => {
    const map = new Map<string, number>();
    for (const genre of [...(catalog?.genres?.movies || []), ...(catalog?.genres?.shows || [])]) map.set(genre.name, genre.id);
    return map;
  }, [catalog]);

  const filtered = useMemo(() => {
    let list = base;
    if (filterType) list = list.filter((item: any) => item.type === filterType);
    if (filterGenre) {
      const id = genreNameToId.get(filterGenre);
      list = list.filter((item: any) => (item.genreIds || []).includes(id!) || false);
    }
    if (filterDecade) list = list.filter((item: any) => item.year && `${Math.floor(item.year / 10) * 10}s` === filterDecade);
    if (filterProvider) list = list.filter((item: any) => (item.facts?.providers || []).includes(filterProvider));
    return applySort(list, sort);
  }, [base, filterDecade, filterGenre, filterProvider, filterType, genreNameToId, sort]);

  const pageParam = Number(route.query.get('page') || '1');
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const goToPage = (next: number) => {
    const params = new URLSearchParams(route.query.toString());
    if (next <= 1) params.delete('page');
    else params.set('page', String(next));
    const basePath = variant === 'search' ? '/search' : `/browse/${encodeURIComponent(rowId || 'all')}`;
    navigate(`${basePath}${params.toString() ? `?${params.toString()}` : ''}`);
  };

  const setQueryParam = (key: string, value: string) => {
    const params = new URLSearchParams(route.query.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete('page');
    navigate(`/browse/${encodeURIComponent(rowId || 'all')}${params.toString() ? `?${params.toString()}` : ''}`, { replace: true });
  };

  const title = variant === 'search' ? (query ? `Results for “${query}”` : 'Search') : row ? row.title : rowId === 'all' ? 'Everything loaded' : 'Unknown row';

  const loadingState = loading.catalog && !items.length;

  return (
    <div>
      <div className="page-head">
        <h1>{title}</h1>
        <p>
          {variant === 'search' ? (
            <>
              The backend exposes no search endpoint (no <span className="mono">/search</span>, and <span className="mono">/discover</span> ignores
              query parameters), so this searches the {items.length} titles already loaded from the backend in this session.
            </>
          ) : row ? (
            <>
              {row.subtitle} · source <span className="mono">{row.endpoint}</span>
            </>
          ) : (
            <>Every title currently loaded from the backend, deduplicated by TMDB id.</>
          )}
        </p>
        <div className="cluster" style={{ marginTop: 12, gap: 8 }}>
          <Pill tone="accent">{filtered.length} titles</Pill>
          {base.length !== filtered.length ? <Pill>{base.length} before filters</Pill> : null}
          {row?.fetchedAt ? <UpdatedPill at={row.fetchedAt} /> : null}
          {catalog?.generatedAt ? <UpdatedPill at={catalog.generatedAt} prefix="catalog" /> : null}
        </div>
      </div>

      {variant === 'row' && rowId !== 'all' && !row && !loadingState ? (
        <div className="section">
          <Note
            tone="warn"
            title="That row is not loaded right now"
            detail="Either the source that provides it is failing (see the Backend view) or the id does not exist. Try a forced refresh from the header."
          />
        </div>
      ) : null}

      <div className="filters">
        <select value={filterType} onChange={(event) => { setFilterType(event.target.value); goToPage(1); }} aria-label="Filter by type">
          <option value="">All types</option>
          {facets.types.map((facet) => (
            <option key={facet.value} value={facet.value}>
              {facet.value === 'movie' ? 'Movies' : facet.value === 'show' ? 'TV shows' : facet.value} ({facet.count})
            </option>
          ))}
        </select>

        {facets.genres.length ? (
          <select value={filterGenre} onChange={(event) => { setFilterGenre(event.target.value); setQueryParam('genre', event.target.value); }} aria-label="Filter by genre">
            <option value="">All genres</option>
            {facets.genres.map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.value} ({facet.count})
              </option>
            ))}
          </select>
        ) : null}

        {facets.decades.length ? (
          <select value={filterDecade} onChange={(event) => { setFilterDecade(event.target.value); goToPage(1); }} aria-label="Filter by decade">
            <option value="">All years</option>
            {facets.decades.map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.value} ({facet.count})
              </option>
            ))}
          </select>
        ) : null}

        {facets.providers.length ? (
          <select value={filterProvider} onChange={(event) => { setFilterProvider(event.target.value); goToPage(1); }} aria-label="Filter by provider">
            <option value="">All providers</option>
            {facets.providers.map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.value} ({facet.count})
              </option>
            ))}
          </select>
        ) : null}

        <select value={sort} onChange={(event) => { setSort(event.target.value as SortKey); goToPage(1); }} aria-label="Sort results">
          <option value="source">Backend order</option>
          <option value="rating">Highest rated</option>
          <option value="year-desc">Newest first</option>
          <option value="year-asc">Oldest first</option>
          <option value="title">Title A–Z</option>
          <option value="plays">Most plays reported</option>
        </select>

        <button
          className="pill pill--button"
          onClick={() => {
            setFilterType('');
            setFilterGenre('');
            setFilterDecade('');
            setFilterProvider('');
            setSort('source');
            setQueryParam('genre', '');
          }}
        >
          Reset filters
        </button>
      </div>

      {loadingState ? (
        <div className="grid">
          {Array.from({ length: 8 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      ) : pageItems.length ? (
        <CardGrid items={pageItems} onOpen={onOpen} />
      ) : variant === 'search' && !query ? (
        <EmptyState title="Type to search">
          <span className="cluster" style={{ justifyContent: 'center', gap: 6 }}>
            <SearchIcon size={14} /> Matches titles, years, TMDB ids, providers and synopses of loaded records.
          </span>
        </EmptyState>
      ) : (
        <EmptyState title="No titles match these filters">
          Filters apply to what the backend already returned for this session.
        </EmptyState>
      )}

      {pageCount > 1 ? (
        <div className="pager">
          <button className="btn btn--sm" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1}>
            <ChevronLeft size={16} /> Prev
          </button>
          <span>
            Page {currentPage} of {pageCount} · {filtered.length} titles
          </span>
          <button className="btn btn--sm" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount}>
            Next <ChevronRight size={16} />
          </button>
        </div>
      ) : null}

      {filtered.length ? (
        <p className="pager" style={{ paddingBottom: 0, color: 'var(--muted-2)' }}>
          Paging is client-side ({PAGE_SIZE} per page): the Aether backend exposes no pagination parameters for any of these endpoints.
        </p>
      ) : null}
    </div>
  );
}
