/**
 * Server-side account handling.
 *
 * The Aether backend authenticates with a **mnemonic + Ed25519 challenge**
 * (no password, no email, no OAuth):
 *
 *   POST /auth/login/start     { publicKey }            -> { challenge }
 *   POST /auth/login/complete  { publicKey, challenge:{ code, signature }, device }
 *                                                        -> { user, session, token }
 *
 * The keypair is derived exactly the way the backend's own
 * `POST /auth/derive-public-key` does it — PBKDF2-HMAC-SHA256(mnemonic, salt
 * "mnemonic", 2048 iters, 32 bytes) -> Ed25519 seed — so a mnemonic created
 * here is portable to the official Aether clients and vice-versa.
 *
 * Where the secret lives:
 *   - `AETHER_MNEMONIC` in `.env` (recommended): the server signs in at boot.
 *   - or posted once to `POST /api/auth/login`, kept in server memory only.
 *   *The mnemonic is never written to disk, never returned to the browser and
 *   never logged.* Only the resulting session token is cached on the server
 *   (git-ignored `data/session.json`, mode 600) so a restart keeps you signed in.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pbkdf2 } from 'node:crypto';
import nacl from 'tweetnacl';
import { config } from './config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pbkdf2Async(password, salt, iterations, keyLen, digest) {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, keyLen, digest, (error, derived) => {
      if (error) reject(error);
      else resolve(new Uint8Array(derived));
    });
  });
}

/** mnemonic -> { publicKey, secretKey } (matches the backend's derivation). */
export async function deriveKeyPair(mnemonic) {
  const seed = await pbkdf2Async(mnemonic, 'mnemonic', 2048, 32, 'sha256');
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  return {
    publicKey: toBase64Url(keyPair.publicKey),
    secretKey: keyPair.secretKey,
    sign: (message) => toBase64Url(nacl.sign.detached(Buffer.from(String(message)), keyPair.secretKey)),
  };
}

const ALLOWED_ICON_RE = /^[a-z0-9_-]{1,32}$/;

export class AccountService {
  /**
   * @param {{ transport: import('./transport.mjs').AetherTransport, loadLibrary?: Function }} deps
   */
  constructor({ transport }) {
    this.transport = transport;
    /** @type {{ token: string, user: any, session: any, method: 'env'|'token'|'login'|'register', signedInAt: string }|null} */
    this.session = null;
    /** @type {string|null} */
    this.mnemonic = config.mnemonic;
    this.booting = null;
    this.loginAttempts = [];
  }

  /* ------------------------- lifecycle ------------------------- */

  async init() {
    if (this.session?.user) return this.session;
    // Idempotent: the boot-time sign-in and any incoming request share one attempt.
    if (this.booting) return this.booting;
    this.booting = this.#initialize();
    try {
      return await this.booting;
    } finally {
      this.booting = null;
    }
  }

  async #initialize() {
    // 1. Operator-provided token wins (cheapest, nothing to derive).
    if (config.sessionToken) {
      const restored = await this.#adoptToken(config.sessionToken, 'token');
      if (restored) return this.session;
    }

    // 2. A cached token from a previous run.
    const cached = await this.#readSessionFile();
    if (cached?.token && cached.token !== config.sessionToken) {
      const restored = await this.#adoptToken(cached.token, cached.method || 'login');
      if (restored) return this.session;
    }

    // 3. Configured mnemonic.
    if (this.mnemonic) {
      try {
        await this.signIn(this.mnemonic, { method: 'env', persistMnemonic: false });
      } catch (error) {
        console.warn(`[aether] could not sign in with AETHER_MNEMONIC: ${error.message}`);
      }
    }

    return this.session;
  }

  async #adoptToken(token, method) {
    const result = await this.transport.request('/users/@me', { token, timeoutMs: 12000, retries: 0 });
    if (!result.ok) {
      if (result.networkError) {
        // Offline: keep the token so it can be used once the network is back.
        this.session = { token, user: null, session: null, method, signedInAt: new Date().toISOString(), pending: true };
      }
      return false;
    }
    this.session = {
      token,
      user: result.data?.user || null,
      session: result.data?.session || null,
      method,
      signedInAt: new Date().toISOString(),
    };
    return true;
  }

  /* ------------------------- sign in ------------------------- */

  throttleCheck() {
    const now = Date.now();
    this.loginAttempts = this.loginAttempts.filter((at) => now - at < 60_000);
    if (this.loginAttempts.length >= 6) {
      throw Object.assign(new Error('Too many sign-in attempts — wait a minute and try again.'), { statusCode: 429 });
    }
    this.loginAttempts.push(now);
  }

  /**
   * @param {string} mnemonic
   * @param {{ method?: 'env'|'login', persistMnemonic?: boolean, device?: string }} [options]
   */
  async signIn(mnemonic, options = {}) {
    const phrase = String(mnemonic || '').trim();
    if (phrase.split(/\s+/).length < 3) {
      throw Object.assign(new Error('That does not look like a mnemonic (expected 12+ words).'), { statusCode: 400 });
    }

    const keyPair = await deriveKeyPair(phrase);
    const device = (options.device || config.deviceName).slice(0, 200);

    const start = await this.transport.request('/auth/login/start', {
      method: 'POST',
      body: { publicKey: keyPair.publicKey },
      retries: 0,
      timeoutMs: 15000,
    });
    if (!start.ok) {
      if (start.status === 401) {
        throw Object.assign(new Error('This backend does not know that mnemonic (POST /auth/login/start answered 401 "User cannot be found").'), {
          statusCode: 401,
          backend: start,
        });
      }
      throw Object.assign(new Error(start.error || 'Sign-in failed at /auth/login/start'), { statusCode: start.status || 502, backend: start, networkError: start.networkError });
    }

    const challenge = start.data?.challenge;
    if (!challenge) throw Object.assign(new Error('Backend did not return a challenge code.'), { statusCode: 502 });

    const complete = await this.transport.request('/auth/login/complete', {
      method: 'POST',
      body: {
        publicKey: keyPair.publicKey,
        challenge: { code: challenge, signature: keyPair.sign(challenge) },
        device,
      },
      retries: 0,
      timeoutMs: 15000,
    });
    if (!complete.ok || !complete.data?.token) {
      throw Object.assign(new Error(complete.error || 'Sign-in failed at /auth/login/complete'), {
        statusCode: complete.status || 502,
        backend: complete,
      });
    }

    this.session = {
      token: complete.data.token,
      user: complete.data.user || null,
      session: complete.data.session || null,
      method: options.method || 'login',
      signedInAt: new Date().toISOString(),
    };
    if (options.persistMnemonic !== false) this.mnemonic = phrase;
    await this.#writeSessionFile({ token: this.session.token, userId: this.session.user?.id || null, method: this.session.method });
    return this.publicSession();
  }

  /* ------------------------- register ------------------------- */

  /**
   * Creates a brand new Aether account and returns the mnemonic exactly once.
   * The mnemonic *is* the account: whoever holds it can sign in anywhere.
   */
  async register() {
    // Captcha: the deployment reports hasCaptcha=false today. If a backend ever
    // enables it, we refuse instead of silently failing.
    const meta = await this.transport.request('/meta', { timeoutMs: 10000, retries: 0 });
    if (meta.ok && meta.data?.hasCaptcha === true && !config.captchaToken) {
      throw Object.assign(
        new Error('This backend requires a captcha to register. Set AETHER_CAPTCHA_TOKEN (from the provider) on the server, or create the account in the official app and sign in here with its mnemonic.'),
        { statusCode: 400 }
      );
    }

    const { generateMnemonic, wordlist } = await import('@scure/bip39/wordlists/english');
    const bip39 = await import('@scure/bip39');
    const mnemonic = bip39.generateMnemonic(wordlist, 128);

    const start = await this.transport.request('/auth/register/start', {
      method: 'POST',
      body: config.captchaToken ? { captchaToken: config.captchaToken } : {},
      retries: 0,
      timeoutMs: 15000,
    });
    if (!start.ok) throw Object.assign(new Error(start.error || 'Register failed at /auth/register/start'), { statusCode: start.status || 502, backend: start });

    const challenge = start.data?.challenge;
    if (!challenge) throw Object.assign(new Error('Backend did not return a challenge code.'), { statusCode: 502 });

    const keyPair = await deriveKeyPair(mnemonic);
    const profile = {
      colorA: randomHexColor(),
      colorB: randomHexColor(),
      icon: ALLOWED_ICON_RE.test(config.namespace) ? 'popcorn' : 'popcorn',
    };

    const complete = await this.transport.request('/auth/register/complete', {
      method: 'POST',
      body: {
        publicKey: keyPair.publicKey,
        challenge: { code: challenge, signature: keyPair.sign(challenge) },
        namespace: config.namespace.slice(0, 200),
        device: config.deviceName.slice(0, 200),
        profile,
      },
      retries: 0,
      timeoutMs: 15000,
    });
    if (!complete.ok || !complete.data?.token) {
      throw Object.assign(new Error(complete.error || 'Register failed at /auth/register/complete'), { statusCode: complete.status || 502, backend: complete });
    }

    this.session = {
      token: complete.data.token,
      user: complete.data.user || null,
      session: complete.data.session || null,
      method: 'register',
      signedInAt: new Date().toISOString(),
    };
    this.mnemonic = mnemonic;
    await this.#writeSessionFile({ token: this.session.token, userId: this.session.user?.id || null, method: 'register' });
    return { mnemonic, session: this.publicSession() };
  }

  /* ------------------------- sign out ------------------------- */

  async signOut({ revoke = true } = {}) {
    const current = this.session;
    this.session = null;
    this.mnemonic = null;
    await this.#clearSessionFile();

    if (!revoke || !current?.token) return { revoked: false };

    // Revoke the session upstream so the token cannot be replayed.
    const sid = current.session?.id;
    if (!sid) return { revoked: false };
    const result = await this.transport.request(`/sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
      token: current.token,
      retries: 0,
      timeoutMs: 10000,
    });
    return { revoked: result.ok, status: result.status ?? null, error: result.ok ? null : result.error };
  }

  /* ------------------------- helpers ------------------------- */

  get token() {
    return this.session?.token || null;
  }

  get userId() {
    return this.session?.user?.id || null;
  }

  isSignedIn() {
    return Boolean(this.session?.token && this.session?.user);
  }

  publicSession() {
    if (!this.session) return { signedIn: false };
    return {
      signedIn: Boolean(this.session.user),
      pending: Boolean(this.session.pending),
      method: this.session.method,
      signedInAt: this.session.signedInAt,
      user: this.session.user,
      session: this.session.session
        ? { id: this.session.session.id, device: this.session.session.device, expiresAt: this.session.session.expiresAt, createdAt: this.session.session.createdAt }
        : null,
    };
  }

  async #readSessionFile() {
    try {
      const raw = await fs.readFile(config.sessionFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async #writeSessionFile(payload) {
    try {
      await fs.mkdir(path.dirname(config.sessionFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(config.sessionFile, JSON.stringify({ ...payload, savedAt: new Date().toISOString() }, null, 2), 'utf8');
      await fs.chmod(config.sessionFile, 0o600).catch(() => {});
    } catch (error) {
      console.warn(`[aether] could not cache the session token: ${error.message}`);
    }
  }

  async #clearSessionFile() {
    await fs.rm(config.sessionFile, { force: true }).catch(() => {});
  }
}

function randomHexColor() {
  const value = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `#${value}`;
}

export { sleep };
