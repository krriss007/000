import React, { useState } from 'react';
import { posterUrl, TYPE_LABEL } from '@shared/normalize.js';
import { formatNumber, gradientFor, initials } from '../lib/format';
import { StarIcon } from './Icons';

export interface CardProps {
  item: any;
  onOpen: (item: any) => void;
  /** Small extra line under the title (row-specific context). */
  footnote?: string;
}

function subtitleFor(item: any): string {
  const parts: string[] = [];
  parts.push(TYPE_LABEL[item.type] || 'Title');
  if (item.year) parts.push(String(item.year));
  if (item.episodeLabel) parts.push(item.episodeLabel);
  if (item.userState?.percent) parts.push(`${item.userState.percent}% watched`);
  else if (item.facts?.watched) parts.push(`${formatNumber(item.facts.watched)} plays`);
  if (item.idOnly && !item.title) parts.push('id only');
  return parts.join(' · ');
}

export function Card({ item, onOpen, footnote }: CardProps) {
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
  const poster = posterUrl(item);
  const rating = item.rating ?? item.userState?.rating ?? null;
  const progress = item.userState?.percent ?? null;
  const label = item.title || (item.tmdbId ? `TMDB #${item.tmdbId}` : 'Unknown title');

  return (
    <button className="card" onClick={() => onOpen(item)} aria-label={`${label} — open details`}>
      <div className="card__art" style={{ backgroundImage: gradientFor(item.id || label) }}>
        <div className="card__fallback" aria-hidden>
          {initials(item.title || label)}
        </div>
        {poster && imageState !== 'error' ? (
          <img
            className={`card__img ${imageState === 'ready' ? 'card__img--ready' : ''}`}
            src={poster}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setImageState('ready')}
            onError={() => setImageState('error')}
          />
        ) : null}

        <div className="card__badges">
          <span className="card__badge">
            {item.type === 'show' ? 'TV' : item.type === 'movie' ? 'Movie' : 'Title'}
          </span>
          <span className="cluster" style={{ gap: 6 }}>
            {item.idOnly && !item.posterPath ? (
              <span className="card__badge card__badge--id" title="The backend only exposed a TMDB id for this record">
                id only
              </span>
            ) : null}
            {rating ? (
              <span className="card__badge card__badge--rating" title={item.userState?.rating ? 'Your rating' : 'TMDB vote average'}>
                <StarIcon /> {Number(rating).toFixed(1)}
              </span>
            ) : null}
          </span>
        </div>

        <div className="card__overlay">
          <div className="card__overlay-title">{label}</div>
          <div className="card__overlay-meta">{subtitleFor(item)}</div>
        </div>

        {progress ? (
          <div className="card__progress" title={`${progress}% watched`}>
            <span style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
        ) : null}
      </div>
      <div className="card__caption">
        <p className="card__title">{label}</p>
        <p className="card__sub">{footnote || subtitleFor(item)}</p>
      </div>
    </button>
  );
}

export function CardGrid({
  items,
  onOpen,
  footnoteFor,
}: {
  items: any[];
  onOpen: (item: any) => void;
  footnoteFor?: (item: any) => string | undefined;
}) {
  return (
    <div className="grid">
      {items.map((item, index) => (
        <Card key={`${item.id}-${index}`} item={item} onOpen={onOpen} footnote={footnoteFor?.(item)} />
      ))}
    </div>
  );
}
