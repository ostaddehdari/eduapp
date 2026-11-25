import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule, WorkerService } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
try {
  new Logger('Worker').log(app.get(WorkerService).readiness());
} finally {
  await app.close();
}
