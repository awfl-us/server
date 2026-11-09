import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownscopedClient } from 'google-auth-library';
import { buildWorkspaceCab, projectWorkspacePrefix } from './storageTokens.js';

test('a workspace gets its own path, not a session or bucket-wide token', () => {
  const left = projectWorkspacePrefix('owner', 'p1');
  const right = projectWorkspacePrefix('owner', 'p2');
  const otherUser = projectWorkspacePrefix('someone-else', 'p1');
  assert.equal(left, 'users/owner/projects/p1/files/');
  assert.notEqual(left, right);
  assert.notEqual(left, otherUser);
  assert.equal(projectWorkspacePrefix('a/b', 'p1'), 'users/a%2Fb/projects/p1/files/');
  assert.equal(projectWorkspacePrefix("a'b", 'p1'), 'users/a%27b/projects/p1/files/');
  assert.throws(() => projectWorkspacePrefix('a\n', 'p1'));
});

test('CAB restricts object operations AND prefix-filtered listings in one rule', () => {
  const prefix = projectWorkspacePrefix('owner', 'p1');
  const boundary = buildWorkspaceCab('awfl-us-work-bucket', prefix);
  const rules = boundary.accessBoundary.accessBoundaryRules;
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].availablePermissions, ['inRole:roles/storage.objectAdmin']);
  assert.match(rules[0].availabilityCondition.expression, /resource\.name\.startsWith/);
  assert.match(rules[0].availabilityCondition.expression, /storage\.googleapis\.com\/objectListPrefix/);
  assert.ok(rules[0].availabilityCondition.expression.includes(prefix));
  assert.throws(() => buildWorkspaceCab('invalid/escape', prefix));

  // Confirm the constructor used by the version pinned in this server.
  assert.doesNotThrow(() => new DownscopedClient({ getAccessToken: async () => ({ token: 'fake' }) }, boundary));
});
