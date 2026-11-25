import { Controller, Get, Module } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { service: 'api', status: 'ok', version: '0.1.0' };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
