import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeDefaults } from '../src/index.js';

test('config exposes its workspace API', () => {
  assert.equal(runtimeDefaults.apiPort, 3000);
});
