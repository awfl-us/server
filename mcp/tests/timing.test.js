import test from 'node:test';
import assert from 'node:assert/strict';
import { commandTimingsMs } from '../timing.js';

test('command timings distinguish submission, relay delivery and execution', () => {
  assert.deepEqual(commandTimingsMs({
    createdAt: 1000, dispatchedAt: 1040, claimedAt: 1150,
    completedAt: 1470,
  }, 5000), {
    submission: 40, delivery: 110, execution: 320, total: 470, elapsed: 470,
  });
});

test('pending and running commands expose age without invented stages', () => {
  assert.deepEqual(commandTimingsMs({ createdAt: 1000 }, 1500), {
    submission: null, delivery: null, execution: null, total: null, elapsed: 500,
  });
  assert.deepEqual(commandTimingsMs({
    createdAt: 1000, dispatchedAt: 1100, claimedAt: 1300,
  }, 1900), {
    submission: 100, delivery: 200, execution: null, total: null, elapsed: 900,
  });
});

test('old or malformed timestamps produce null rather than negative duration', () => {
  assert.deepEqual(commandTimingsMs({
    createdAt: 3000, dispatchedAt: 2500, claimedAt: 3200, completedAt: 3600,
  }, 4000), {
    submission: null, delivery: 700, execution: 400, total: 600, elapsed: 600,
  });
  assert.deepEqual(commandTimingsMs({}, 4000), {
    submission: null, delivery: null, execution: null, total: null, elapsed: null,
  });
});
