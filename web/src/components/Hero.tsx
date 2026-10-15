import React, { useEffect, useState } from 'react';
import { TYPE_LABEL, backdropUrl } from '@shared/normalize.js';
import { formatMoney, formatNumber, gradientFor, initials, tmdbWebUrl } from '../lib/format';
import { relativeTime } from '../lib/format';
import { ExternalIcon, StarIcon } from './Icons';
import { UpdatedPill } from './primitives';

export function Hero({ item, onOpen }: { item: any; onOpen: (item: any) => void }) {
  const [broken, setBroken] = useState(false);
  const backdrop = backdropUrl(item, 'w1280');

  // The backend never proxies artwork, so a failing TMDB image must degrade to
  // generated art instead of leaving an empty hero.
  useEffect(() => {
    setBroken(false);
    if (!backdrop) return;
    const probe = new Image();
    probe.onerror = () => setBroken(true);
    probe.src = backdrop;
    return () => {
      probe.onerror = null;
    };
  }, [backdrop]);

  if (!item) return null;

  const link = tmdbWebUrl(item);
  const facts: string[] = [];
  if (item.type) facts.push(TYPE_LABEL[item.type] || 'Title');
  if (item.year) facts.push(String(item.year));
  if (item.facts?.watched) facts.push(`${formatNumber(item.facts.watched)} plays (24h–7d)`);
  if (item.facts?.watchers) facts.push(`${formatNumber(item.facts.watchers)} watchers`);
  if (item.facts?.plays) facts.push(`${formatNumber(item.facts.plays)} plays`);
  if (item.facts?.revenue) facts.push(`${formatMoney(item.facts.revenue)} box office`);

  return (
    <section className="hero" aria-label="Featured title">
      {backdrop && !broken ? (
        <div
          className="hero__bg"
          style={{ backgroundImage: `url(${backdrop})` }}
          role="img"
          aria-label={`Backdrop for ${item.title || 'featured title'}`}
        />
      ) : (
        <div className="hero__fallback" style={{ backgroundImage: gradientFor(item.id) }} />
      )}
      <div className="hero__scrim" />

      <div className="hero__inner">
        <span className="hero__eyebrow">
          <span className="dot" /> Featured · from the backend
        </span>
        <h1 className="hero__title">{item.title || `TMDB #${item.tmdbId}`}</h1>

        <div className="hero__meta">
          {item.rating ? (
            <span className="cluster" style={{ gap: 6, color: '#ffd479', fontWeight: 650 }}>
              <StarIcon /> {Number(item.rating).toFixed(1)}
            </span>
          ) : null}
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
          {item.idOnly ? <span className="pill pill--warn">Id-only record</span> : null}
        </div>

        {item.overview ? <p className="hero__overview">{item.overview}</p> : null}

        <div className="hero__actions">
          <button className="btn btn--primary" onClick={() => onOpen(item)}>
            View details
          </button>
          {link ? (
            <a className="btn" href={link} target="_blank" rel="noreferrer noopener">
              Open on TMDB <ExternalIcon />
            </a>
          ) : null}
        </div>

        <div className="hero__source">
          {item.featuredFrom ? (
            <>
              Source: <span className="mono">{item.featuredFrom.endpoint}</span> ({item.featuredFrom.rowTitle}) · fetched{' '}
              {relativeTime(item.featuredFrom.fetchedAt)} <UpdatedPill at={item.featuredFrom.fetchedAt} prefix="·" />
            </>
          ) : (
            <>Source: backend catalog rows</>
          )}
        </div>
      </div>

    </section>
  );
}

export function HeroSkeleton() {
  return (
    <section className="hero" aria-hidden>
      <div className="hero__fallback" style={{ backgroundImage: 'linear-gradient(140deg, #171726, #0d0d16)' }} />
      <div className="hero__scrim" />
      <div className="hero__inner stack">
        <div className="skeleton" style={{ width: 190, height: 16 }} />
        <div className="skeleton" style={{ width: 'min(560px, 80%)', height: 54 }} />
        <div className="skeleton" style={{ width: 'min(420px, 60%)', height: 14 }} />
        <div className="skeleton" style={{ width: 'min(300px, 45%)', height: 38, borderRadius: 999 }} />
      </div>
    </section>
  );
}
