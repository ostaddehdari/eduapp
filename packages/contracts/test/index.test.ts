import assert from 'node:assert/strict';
import test from 'node:test';
import { contractVersion } from '../src/index.js';

test('contracts exposes its workspace API', () => {
  assert.equal(contractVersion, '0.1.0');
});
