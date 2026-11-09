'use strict';
/**
 * Append-only audit log (persisted, ring-capped).
 * Records: account connections, config changes, trade previews, confirmations,
 * orders, cancellations, kill-switch events, mode switches. Never logs secrets.
 */
const { AUDIT_LOG_LIMIT } = require('./config');

function makeAudit(store) {
  function log(action, details = {}) {
    const entry = {
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      actor: 'user',
      action,
      details: sanitize(details),
    };
    store.update(s => {
      s.auditLog.push(entry);
      if (s.auditLog.length > AUDIT_LOG_LIMIT) s.auditLog = s.auditLog.slice(-AUDIT_LOG_LIMIT);
    });
    return entry;
  }
  // Defense in depth: strip anything that smells like a secret before persisting.
  function sanitize(obj) {
    const SECRET_KEYS = /secret|apikey|api_key|password|token|private/i;
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o = {};
        for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '[redacted]' : walk(val);
        return o;
      }
      return v;
    };
    try { return walk(JSON.parse(JSON.stringify(obj))); } catch { return { note: '[unserializable details]' }; }
  }
  function list(limit = 200) { return store.get().auditLog.slice(-limit).reverse(); }
  return { log, list };
}
module.exports = { makeAudit };
