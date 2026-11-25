import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';

test('NestJS serves the API health endpoint', async () => {
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(new URL('/api/health', await app.getUrl()));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: 'api', status: 'ok', version: '0.1.0' });
  } finally {
    await app.close();
  }
});
