import React, { useRef } from 'react';
import { navigate, routeHref } from '../lib/router';
import { Card } from './Card';
import { ChevronLeft, ChevronRight } from './Icons';
import { UpdatedPill } from './primitives';

export function Row({ row, onOpen }: { row: any; onOpen: (item: any) => void }) {
  const scroller = useRef<HTMLDivElement>(null);

  const scrollBy = (direction: 1 | -1) => {
    const node = scroller.current;
    if (!node) return;
    node.scrollBy({ left: direction * Math.max(280, node.clientWidth * 0.85), behavior: 'smooth' });
  };

  const headingId = `row-${row.id}`;

  return (
    <section className="row" aria-labelledby={headingId}>
      <div className="row__head">
        <h2 className="row__title" id={headingId}>
          {row.title}
        </h2>
        <div className="row__sub">
          <span>{row.subtitle}</span>
          <span aria-hidden>·</span>
          <span>
            {row.items.length} {row.items.length === 1 ? 'title' : 'titles'}
          </span>
          <UpdatedPill at={row.fetchedAt} />
        </div>
        <div className="row__actions">
          <a className="btn btn--ghost btn--sm" href={routeHref('browse', row.id)} onClick={(event) => { event.preventDefault(); navigate(`/browse/${encodeURIComponent(row.id)}`); }}>
            See all
          </a>
        </div>
      </div>

      <button className="row__arrow row__arrow--prev" onClick={() => scrollBy(-1)} aria-label={`Scroll ${row.title} backwards`}>
        <ChevronLeft />
      </button>

      <div className="row__scroller" ref={scroller} tabIndex={0} role="group" aria-label={`${row.title} carousel`}>
        {row.items.map((item: any, index: number) => (
          <Card key={`${row.id}-${item.id}-${index}`} item={item} onOpen={onOpen} />
        ))}
      </div>

      <button className="row__arrow row__arrow--next" onClick={() => scrollBy(1)} aria-label={`Scroll ${row.title} forwards`}>
        <ChevronRight />
      </button>
    </section>
  );
}
