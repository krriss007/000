import React, { useEffect, useState } from 'react';
import { absoluteTime, relativeTime } from '../lib/format';
import { useStore } from '../lib/store';
import { CloseIcon, ExternalIcon } from './Icons';
import { Note, Pill, Spinner } from './primitives';

export function AuthDialog({ onClose }: { onClose: () => void }) {
  const { account, loading, mode, signIn, signOut, createAccount, library, pushToast } = useStore();
  const [tab, setTab] = useState<'signin' | 'create'>('signin');
  const [mnemonic, setMnemonic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const directMode = mode === 'direct';

  const submitSignIn = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(mnemonic.trim());
      setMnemonic('');
      onClose();
    } catch (caught: any) {
      setError(caught?.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    setError(null);
    setBusy(true);
    try {
      const phrase = await createAccount();
      setCreated(phrase || null);
    } catch (caught: any) {
      setError(caught?.message || 'Account creation failed');
    } finally {
      setBusy(false);
    }
  };

  const copyMnemonic = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      pushToast({ kind: 'ok', title: 'Mnemonic copied', message: 'Paste it into your password manager now.' });
    } catch {
      pushToast({ kind: 'danger', title: 'Could not copy', message: 'Select the text and copy it manually.' });
    }
  };

  return (
    <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet sheet--sm" role="dialog" aria-modal="true" aria-label="Aether account" style={{ maxHeight: '90vh' }}>
        <button className="sheet__close" onClick={onClose} aria-label="Close account panel">
          <CloseIcon />
        </button>

        <div className="sheet__body" style={{ paddingTop: 26 }}>
          <h2 className="panel__title" style={{ fontSize: 20, marginBottom: 6 }}>
            Aether account
          </h2>
          <p className="panel__hint">
            Accounts on this backend are mnemonic + Ed25519: no email, no password. The app server derives the keys, signs the backend's
            challenge and keeps the session token — the mnemonic never reaches this browser.
          </p>

          {directMode ? (
            <div style={{ marginTop: 14 }}>
              <Note
                tone="warn"
                title="Account features need the server path"
                detail="This deployment's server cannot reach the backend from its network, so data is being fetched directly by the browser. Sign-in stays disabled here on purpose: putting a mnemonic in browser code is exactly what we must avoid."
              />
            </div>
          ) : null}

          {account?.signedIn ? (
            <div className="stack" style={{ marginTop: 18 }}>
              <div className="panel">
                <div className="panel__head">
                  <span
                    className="avatar"
                    style={{
                      width: 38,
                      height: 38,
                      fontSize: 16,
                      background: `linear-gradient(135deg, ${account.user?.profile?.colorA || '#7c5cff'}, ${account.user?.profile?.colorB || '#22d3ee'})`,
                    }}
                  >
                    {(account.user?.nickname || account.user?.namespace || 'A').slice(0, 1)}
                  </span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{account.user?.nickname || 'Signed in'}</div>
                    <div className="panel__hint">namespace {account.user?.namespace || '—'}</div>
                  </div>
                  <span className="spacer" />
                  <Pill tone="ok">session active</Pill>
                </div>

                <div className="facts" style={{ marginTop: 6 }}>
                  <div className="fact">
                    <div className="fact__label">User id</div>
                    <div className="fact__value mono" style={{ fontSize: 12 }}>
                      {account.user?.id}
                    </div>
                  </div>
                  <div className="fact">
                    <div className="fact__label">Signed in</div>
                    <div className="fact__value">{relativeTime(account.signedInAt)} via {account.method || 'login'}</div>
                  </div>
                  <div className="fact">
                    <div className="fact__label">Session device</div>
                    <div className="fact__value">{account.session?.device || '—'}</div>
                  </div>
                  <div className="fact">
                    <div className="fact__label">Session expires</div>
                    <div className="fact__value">{account.session?.expiresAt ? absoluteTime(account.session.expiresAt) : '—'}</div>
                  </div>
                  {library?.counts ? (
                    <div className="fact">
                      <div className="fact__label">Library</div>
                      <div className="fact__value">
                        {library.counts.bookmarks} saved · {library.counts.progress} in progress · {library.counts.history} watched
                      </div>
                    </div>
                  ) : null}
                  {library?.sessions?.length ? (
                    <div className="fact">
                      <div className="fact__label">Your devices</div>
                      <div className="fact__value">{library.sessions.length} active session(s)</div>
                    </div>
                  ) : null}
                </div>
              </div>

              {library?.sources?.some((source: any) => !source.ok) ? (
                <Note
                  tone="warn"
                  title="Some of your account endpoints failed"
                  detail={library.sources
                    .filter((source: any) => !source.ok)
                    .map((source: any) => `${source.endpoint}: ${source.error || 'failed'}`)
                    .join(' · ')}
                />
              ) : null}

              <div className="cluster">
                <button className="btn" onClick={() => void signOut()} disabled={loading.account}>
                  {loading.account ? <Spinner /> : null} Sign out &amp; revoke session
                </button>
                <a className="btn btn--ghost" href="https://aether.cx" target="_blank" rel="noreferrer noopener">
                  Open the official app <ExternalIcon />
                </a>
              </div>
              <p className="panel__hint">
                Signing out calls <span className="mono">DELETE /sessions/:sid</span> so the token cannot be replayed, then deletes the cached
                token on this server.
              </p>
            </div>
          ) : (
            <div style={{ marginTop: 16 }}>
              <div className="cluster" style={{ gap: 6, marginBottom: 14 }}>
                <button className={`pill pill--button ${tab === 'signin' ? 'pill--active' : ''}`} onClick={() => setTab('signin')}>
                  Sign in with mnemonic
                </button>
                <button className={`pill pill--button ${tab === 'create' ? 'pill--active' : ''}`} onClick={() => setTab('create')}>
                  Create an account
                </button>
              </div>

              {error ? (
                <div style={{ marginBottom: 12 }}>
                  <Note tone="danger" title="That did not work" detail={error} />
                </div>
              ) : null}

              {tab === 'signin' ? (
                <div className="stack">
                  <div className="field">
                    <label htmlFor="mnemonic">Your Aether mnemonic</label>
                    <textarea
                      id="mnemonic"
                      rows={3}
                      value={mnemonic}
                      placeholder="word word word word word word word word word word word word"
                      onChange={(event) => setMnemonic(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={directMode}
                    />
                  </div>
                  <div className="cluster">
                    <button className="btn btn--primary" onClick={() => void submitSignIn()} disabled={busy || directMode || mnemonic.trim().length < 6}>
                      {busy ? <Spinner /> : null} Sign in
                    </button>
                    <span className="panel__hint">
                      Sent once to this server over your own connection, held in memory, never returned and never logged.
                    </span>
                  </div>
                  <p className="panel__hint">
                    Operators can skip the form entirely: put <span className="mono">AETHER_MNEMONIC</span> in <span className="mono">.env</span> and
                    the server signs in at boot.
                  </p>
                </div>
              ) : (
                <div className="stack">
                  {created ? (
                    <div className="stack">
                      <Note
                        tone="warn"
                        title="Save this mnemonic now — it is the only key to this account"
                        detail="It is shown once, never stored on the server, and cannot be recovered. Anyone holding it can sign in as you."
                      />
                      <div className="field">
                        <label>Your new mnemonic</label>
                        <textarea readOnly rows={3} value={created} onFocus={(event) => event.currentTarget.select()} />
                      </div>
                      <div className="cluster">
                        <button className="btn btn--primary" onClick={() => void copyMnemonic()}>
                          Copy mnemonic
                        </button>
                        <button className="btn" onClick={onClose}>
                          I saved it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Note
                        tone="info"
                        title="This creates a real account on backend.aether.cx"
                        detail="POST /auth/register/start + /auth/register/complete. The backend reports hasCaptcha=false, so no captcha token is needed. The mnemonic is generated server-side (BIP39, 12 words) so it also works in the official app."
                      />
                      <div className="cluster">
                        <button className="btn btn--primary" onClick={() => void submitCreate()} disabled={busy || directMode}>
                          {busy ? <Spinner /> : null} Generate account + mnemonic
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
