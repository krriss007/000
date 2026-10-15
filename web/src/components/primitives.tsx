import React, { useEffect, useState } from 'react';
import { absoluteTime, relativeTime } from '../lib/format';
import { useStore } from '../lib/store';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './Icons';

export function Pill({
  children,
  tone,
  className = '',
  title,
}: {
  children: React.ReactNode;
  tone?: 'ok' | 'warn' | 'danger' | 'accent';
  className?: string;
  title?: string;
}) {
  return (
    <span className={`pill ${tone ? `pill--${tone}` : ''} ${className}`} title={title}>
      {children}
    </span>
  );
}

/** Live "last fetched" indicator that re-renders every 30s. */
export function UpdatedPill({ at, prefix = 'updated' }: { at?: string | null; prefix?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  if (!at) return null;
  return (
    <Pill className="mono" title={absoluteTime(at)}>
      {prefix} {relativeTime(at)}
    </Pill>
  );
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden>
      <div className="skeleton skeleton-card__art" />
      <div className="skeleton skeleton-card__line" />
      <div className="skeleton skeleton-card__line skeleton-card__line--short" />
    </div>
  );
}

export function SkeletonRow({ count = 7 }: { count?: number }) {
  return (
    <section className="row" aria-hidden>
      <div className="row__head">
        <div className="skeleton" style={{ width: 190, height: 20 }} />
      </div>
      <div className="row__scroller">
        {Array.from({ length: count }).map((_, index) => (
          <SkeletonCard key={index} />
        ))}
      </div>
    </section>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Note({
  tone = 'info',
  title,
  children,
  detail,
  actions,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title: string;
  children?: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const Icon = tone === 'danger' || tone === 'warn' ? AlertIcon : tone === 'ok' ? CheckIcon : InfoIcon;
  return (
    <div className={`note ${tone === 'info' ? '' : `note--${tone}`}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span style={{ color: tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : 'var(--accent-2)' }}>
        <Icon />
      </span>
      <div className="note__body">
        <div className="note__title">{title}</div>
        {children ? <div>{children}</div> : null}
        {detail ? <p className="note__detail">{detail}</p> : null}
      </div>
      {actions ? <div className="note__actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <strong style={{ color: 'var(--text-2)' }}>{title}</strong>
      {children ? <div style={{ marginTop: 6, fontSize: 13 }}>{children}</div> : null}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind === 'ok' ? 'toast--ok' : toast.kind === 'danger' ? 'toast--danger' : ''}`}>
          <span style={{ color: toast.kind === 'ok' ? 'var(--ok)' : toast.kind === 'danger' ? 'var(--danger)' : 'var(--accent-2)', marginTop: 1 }}>
            {toast.kind === 'ok' ? <CheckIcon size={16} /> : toast.kind === 'danger' ? <AlertIcon size={16} /> : <InfoIcon size={16} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>{toast.title}</div>
            {toast.message ? <div style={{ color: 'var(--muted)', fontSize: 12.5, wordBreak: 'break-word' }}>{toast.message}</div> : null}
          </div>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification">
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function StatusPill({ ok, status }: { ok: boolean; status?: number | null }) {
  if (ok) return <Pill tone="ok">HTTP {status ?? 200}</Pill>;
  if (status === null || status === undefined) return <Pill tone="danger">unreachable</Pill>;
  return <Pill tone="danger">HTTP {status}</Pill>;
}
