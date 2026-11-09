'use strict';
/**
 * Credential vault: AES-256-GCM authenticated encryption.
 * Plaintext API secrets are NEVER written to disk, logged, or returned to the browser.
 * The master key comes from ARBSCOPE_MASTER_KEY (see config.js). Losing it means stored
 * credentials are unrecoverable — by design.
 *
 * We deliberately request trading-only API keys. Withdrawal permission is never requested,
 * never checked-for, and the code contains no withdrawal call anywhere.
 */
const crypto = require('crypto');

class Vault {
  constructor(masterKeyHex) {
    this.key = Buffer.from(masterKeyHex, 'hex');
    if (this.key.length !== 32) throw new Error('Master key must be 32 bytes (64 hex chars).');
  }
  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
  }
  decrypt(payload) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
  /** Store a venue credential. Keeps only a 4-char hint for the UI (e.g. "…ab12"). */
  storeCredential(store, venue, { apiKey, apiSecret, label }) {
    const encKey = this.encrypt(apiKey);
    const encSecret = this.encrypt(apiSecret);
    store.update(s => {
      s.credentials[venue] = {
        keyEnc: encKey, secretEnc: encSecret,
        keyHint: '…' + String(apiKey).slice(-4),
        label: label || venue,
        addedAt: new Date().toISOString(),
        canTrade: true,
      };
    });
  }
  readCredential(store, venue) {
    const c = store.get().credentials[venue];
    if (!c) return null;
    return { apiKey: this.decrypt(c.keyEnc), apiSecret: this.decrypt(c.secretEnc), keyHint: c.keyHint, label: c.label };
  }
  removeCredential(store, venue) { store.update(s => { delete s.credentials[venue]; }); }
  /** Sanitized list for the browser — never includes key material. */
  listCredentials(store) {
    const out = {};
    for (const [venue, c] of Object.entries(store.get().credentials)) {
      out[venue] = { keyHint: c.keyHint, label: c.label, addedAt: c.addedAt, canTrade: !!c.canTrade };
    }
    return out;
  }
}

module.exports = { Vault };
