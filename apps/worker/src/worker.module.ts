import { Injectable, Module } from '@nestjs/common';

@Injectable()
export class WorkerService {
  readiness() {
    return { service: 'worker', status: 'ok' } as const;
  }
}

@Module({ providers: [WorkerService] })
export class WorkerModule {}
