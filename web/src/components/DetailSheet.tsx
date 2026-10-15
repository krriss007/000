import React, { useEffect, useMemo, useRef } from 'react';
import { TYPE_LABEL, backdropUrl, itemKey, posterUrl } from '@shared/normalize.js';
import { absoluteTime, formatMoney, formatNumber, formatSeconds, gradientFor, initials, relativeTime, tmdbWebUrl } from '../lib/format';
import { useAllItems, useStore } from '../lib/store';
import { CardGrid } from './Card';
import { CloseIcon, ExternalIcon, StarIcon } from './Icons';
import { Note, Pill, UpdatedPill } from './primitives';

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="fact">
      <div className="fact__label">{label}</div>
      <div className="fact__value">{value}</div>
    </div>
  );
}

export function DetailSheet({ item, onClose, onOpen }: { item: any; onClose: () => void; onOpen: (item: any) => void }) {
  const { account } = useStore();
  const { items } = useAllItems();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const similar = useMemo(() => {
    if (!item) return [];
    const key = itemKey(item);
    const genres = new Set<number>(item.genreIds || []);
    return items
      .filter((candidate: any) => itemKey(candidate) !== key)
      .map((candidate: any) => {
        const overlap = (candidate.genreIds || []).filter((id: number) => genres.has(id)).length;
        const sameType = candidate.type === item.type ? 1 : 0;
        return { candidate, score: overlap * 2 + sameType };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.candidate);
  }, [item, items]);

  if (!item) return null;

  const backdrop = backdropUrl(item, 'w1280');
  const poster = posterUrl(item, 'w342');
  const link = tmdbWebUrl(item);
  const rating = item.rating ?? item.userState?.rating ?? null;
  const state = item.userState || {};
  const facts = item.facts || {};
  const title = item.title || (item.tmdbId ? `TMDB #${item.tmdbId}` : 'Unknown title');

  return (
    <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={sheetRef}>
        <button className="sheet__close" onClick={onClose} aria-label="Close details">
          <CloseIcon />
        </button>

        <div className="sheet__hero">
          {backdrop ? <div className="sheet__hero-bg" style={{ backgroundImage: `url(${backdrop})` }} /> : <div className="sheet__hero-bg" style={{ backgroundImage: gradientFor(item.id) }} />}
          <div className="sheet__hero-scrim" />
          <div className="sheet__hero-inner">
            {poster ? (
              <div className="sheet__poster">
                <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </div>
            ) : (
              <div className="sheet__poster" style={{ backgroundImage: gradientFor(item.id), display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 26 }}>
                {initials(title)}
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <h2 className="sheet__title">{title}</h2>
              <div className="cluster" style={{ gap: 8 }}>
                <Pill>{TYPE_LABEL[item.type] || 'Title'}</Pill>
                {item.year ? <Pill>{item.year}</Pill> : null}
                {rating ? (
                  <Pill className="mono" tone="accent">
                    <StarIcon /> {Number(rating).toFixed(1)}
                    {item.userState?.rating ? ' (your rating)' : item.rating ? ' TMDB' : ''}
                  </Pill>
                ) : null}
                {item.episodeLabel ? <Pill>{item.episodeLabel}</Pill> : null}
                {state.groups?.length ? <Pill tone="ok">In {state.groups.join(', ')}</Pill> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="sheet__body">
          {item.idOnly && !item.overview ? (
            <Note tone="warn" title="This backend record only exposes a TMDB id" detail="The endpoint that returned it provides no title, synopsis or artwork. Nothing here is guessed — the id links straight to TMDB." />
          ) : null}

          {item.overview ? <p className="sheet__overview">{item.overview}</p> : null}

          <div className="sheet__actions" style={{ marginTop: 18 }}>
            <div className="hero__actions">
              {link ? (
                <a className="btn btn--primary" href={link} target="_blank" rel="noreferrer noopener">
                  Open on TMDB <ExternalIcon />
                </a>
              ) : null}
              {item._row ? (
                <span className="pill">
                  Found in <strong style={{ marginLeft: 4 }}>{item._row.title}</strong>
                </span>
              ) : null}
            </div>
          </div>

          <div className="facts">
            <Fact label="Type" value={TYPE_LABEL[item.type] || 'Unknown'} />
            <Fact label="TMDB id" value={item.tmdbId ? <a href={link || '#'} target="_blank" rel="noreferrer noopener" className="mono">{item.tmdbId}</a> : '—'} />
            <Fact label="TMDB rating" value={item.rating != null ? `${Number(item.rating).toFixed(2)} / 10` : '—'} />
            <Fact label="Votes" value={item.votes != null ? formatNumber(item.votes) : '—'} />
            <Fact label="Popularity" value={item.popularity != null ? Number(item.popularity).toFixed(1) : '—'} />
            <Fact label="Release" value={item.releaseDate || item.year || '—'} />
            {facts.watched != null ? <Fact label="Plays reported" value={`${formatNumber(facts.watched)} ok · ${formatNumber(facts.failed || 0)} failed`} /> : null}
            {facts.providers?.length ? <Fact label="Reported providers" value={facts.providers.join(', ')} /> : null}
            {facts.watchers != null ? <Fact label="Trakt watchers" value={formatNumber(facts.watchers)} /> : null}
            {facts.plays != null ? <Fact label="Trakt plays" value={formatNumber(facts.plays)} /> : null}
            {facts.revenue != null ? <Fact label="Weekend revenue" value={formatMoney(facts.revenue)} /> : null}
            {state.percent != null ? <Fact label="Your progress" value={`${state.percent}% (${formatSeconds(state.watchedSeconds)} of ${formatSeconds(state.durationSeconds)})`} /> : null}
            {state.updatedAt ? <Fact label="Progress updated" value={relativeTime(state.updatedAt)} /> : null}
            {state.watchedAt ? <Fact label="You watched" value={`${relativeTime(state.watchedAt)}${state.completed ? ' · finished' : ''}`} /> : null}
            <Fact
              label="Source endpoint"
              value={
                <span className="mono">
                  {item.origin || item._row?.endpoint || '—'}
                  {item._row?.fetchedAt ? <span style={{ display: 'block', color: 'var(--muted)' }}>{absoluteTime(item._row.fetchedAt)}</span> : null}
                </span>
              }
            />
          </div>

          {item._row?.fetchedAt ? (
            <div style={{ marginTop: 14 }}>
              <UpdatedPill at={item._row.fetchedAt} prefix="row fetched" />
            </div>
          ) : null}

          {!account?.signedIn ? (
            <div style={{ marginTop: 18 }}>
              <Note
                tone="info"
                title="Sign in to see your own progress, ratings and lists for this title"
                detail="Account data is fetched server-side with your mnemonic; it never enters the browser."
              />
            </div>
          ) : null}

          {similar.length ? (
            <div style={{ marginTop: 24 }}>
              <h3 className="panel__title" style={{ marginBottom: 10 }}>
                Similar in the loaded catalog
              </h3>
              <div style={{ margin: '0 -6px' }}>
                <CardGrid items={similar} onOpen={onOpen} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
