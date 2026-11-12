import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiKeyMetadata, generateApiKey, hashApiKey, matchesApiKeyHash, parseApiKey, isActiveApiKeyRecord,
  API_KEY_LIFETIME_MS, MCP_SCOPE, API_SCOPE, API_KEY_SCOPES,
} from '../core.js';

describe('AWFL API keys', () => {
  it('generates unique versioned keys with strong random secrets', () => {
    const first = generateApiKey();
    const second = generateApiKey();
    assert.match(first.token, /^awfl_v1_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.token, second.token);
    assert.deepEqual(parseApiKey(first.token), { id: first.id });
    assert.equal(first.last4, first.token.slice(-4));
    assert.equal(first.hash, hashApiKey(first.token));
  });

  it('rejects malformed keys without a Firestore lookup', () => {
    for (const token of ['', 'bad-key', 'awfl_v1_abc_abc', 'awfl_v1_' + 'a'.repeat(24) + '_' + 'b'.repeat(42), null]) {
      assert.equal(parseApiKey(token), null);
    }
  });

  it('compares only hashed secrets', () => {
    const first = generateApiKey();
    const second = generateApiKey();
    assert.equal(matchesApiKeyHash(first.token, first.hash), true);
    assert.equal(matchesApiKeyHash(second.token, first.hash), false);
    assert.equal(matchesApiKeyHash(first.token, 'not-a-digest'), false);
  });

  it('returns public metadata without secret fields', () => {
    const generated = generateApiKey();
    const record = {
      ...generated, name: 'My MCP', userId: 'user-123',
      createdAt: Date.now(), expiresAt: Date.now() + API_KEY_LIFETIME_MS,
      scopes: [MCP_SCOPE],
    };
    const meta = apiKeyMetadata(record);
    assert.equal(meta.name, 'My MCP');
    assert.equal(meta.token, undefined);
    assert.equal(meta.hash, undefined);
    assert.equal(meta.userId, undefined);
  });

  it('rejects expired, revoked, and out-of-scope keys', () => {
    const key = generateApiKey();
    const now = Date.now();
    const active = {
      id: key.id, userId: 'owner', name: 'MCP', hash: key.hash,
      scopes: [MCP_SCOPE], expiresAt: now + 1000,
    };
    assert.equal(isActiveApiKeyRecord(key.token, active, { now }), true);
    assert.equal(isActiveApiKeyRecord(key.token, { ...active, expiresAt: now }, { now }), false);
    assert.equal(isActiveApiKeyRecord(key.token, { ...active, userId: '' }, { now }), false);
    assert.equal(isActiveApiKeyRecord(key.token, { ...active, scopes: [] }, { now }), false);
    assert.equal(isActiveApiKeyRecord(key.token, { ...active, hash: '0'.repeat(64) }, { now }), false);
    assert.equal(isActiveApiKeyRecord(key.token, null, { now }), false);
    assert.equal(isActiveApiKeyRecord(key.token, active, { now, requiredScope: 'admin' }), false);
    assert.equal(isActiveApiKeyRecord(key.token, { ...active, scopes: [API_SCOPE] }, { now }), true);
    assert.equal(isActiveApiKeyRecord(key.token, { ...active, scopes: ['other:scope'] }, { now }), false);
    assert.deepEqual(API_KEY_SCOPES, [API_SCOPE, MCP_SCOPE]);
  });

});
