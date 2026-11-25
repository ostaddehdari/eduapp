import assert from 'node:assert/strict';
import test from 'node:test';
import { testClock } from '../src/index.js';

test('test-utils exposes its workspace API', () => {
  assert.equal(testClock('2026-11-25T00:00:00Z').toISOString(), '2026-11-25T00:00:00.000Z');
});
