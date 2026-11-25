import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { WorkerModule, WorkerService } from '../src/worker.module.js';

test('NestJS starts the worker and resolves its provider', async () => {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  try {
    assert.deepEqual(app.get(WorkerService).readiness(), { service: 'worker', status: 'ok' });
  } finally {
    await app.close();
  }
});
