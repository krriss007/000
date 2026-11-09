'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate state per test file process
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arbscope-test-'));
process.env.NODE_ENV = 'test';

const { Store } = require('../server/store');
const { Vault } = require('../server/vault');
const crypto = require('crypto');

test('vault encrypts and decrypts round-trip; plaintext never hits disk', () => {
  const store = new Store(process.env.DATA_DIR);
  const key = crypto.randomBytes(32).toString('hex');
  const vault = new Vault(key);
  vault.storeCredential(store, 'binance', { apiKey: 'AKIA-test-key-12345', apiSecret: 'super-secret-abcdef', label: 'test' });
  const disk = fs.readFileSync(store.file, 'utf8');
  assert.ok(!disk.includes('super-secret-abcdef'), 'secret persisted in plaintext!');
  assert.ok(!disk.includes('AKIA-test-key-12345'), 'key persisted in plaintext!');
  const read = vault.readCredential(store, 'binance');
  assert.equal(read.apiKey, 'AKIA-test-key-12345');
  assert.equal(read.apiSecret, 'super-secret-abcdef');
  // Sanitized listing has hint only
  const listed = vault.listCredentials(store);
  assert.equal(listed.binance.keyHint, '…2345');
  assert.ok(!JSON.stringify(listed).includes('super-secret'));
});

test('vault with wrong master key cannot decrypt; tampering fails GCM auth', () => {
  const store = new Store(process.env.DATA_DIR);
  const vault1 = new Vault(crypto.randomBytes(32).toString('hex'));
  vault1.storeCredential(store, 'kraken', { apiKey: 'K-key-9999', apiSecret: 'K-secret-9999' });
  const vault2 = new Vault(crypto.randomBytes(32).toString('hex'));
  assert.throws(() => vault2.readCredential(store, 'kraken'));
  // Tamper with ciphertext
  store.update(s => { const c = s.credentials.kraken.secretEnc; c.ciphertext = Buffer.from('AAAA' + Buffer.from(c.ciphertext, 'base64').toString('base64')).toString('base64'); });
  assert.throws(() => vault1.readCredential(store, 'kraken'));
});

test('audit log redacts secret-looking fields', () => {
  const { makeAudit } = require('../server/audit');
  const store = new Store(process.env.DATA_DIR);
  const audit = makeAudit(store);
  audit.log('credentials.added', { venue: 'binance', apiKey: 'SHOULD_NOT_APPEAR', nested: { api_secret: 'NOPE', ok: 'fine' } });
  const [entry] = audit.list(1);
  assert.equal(entry.details.apiKey, '[redacted]');
  assert.equal(entry.details.nested.api_secret, '[redacted]');
  assert.equal(entry.details.nested.ok, 'fine');
});
