import { Controller, Get, Headers, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { safeEqual } from '../../common/crypto';
import { Errors } from '../../common/errors';
import { config } from '../../config/config';
import { Database } from '../../database/db';
import { registry } from './metrics';

@ApiTags('health')
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly db: Database) {}

  /** Liveness: the process is running (no dependencies checked). */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: database reachable and schema migrated. Returns 503 otherwise. */
  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    try {
      const r = await this.db.one<{ migrations: number }>('SELECT count(*)::int AS migrations FROM schema_migrations');
      return { status: 'ok', database: 'ok', migrations: r.migrations, latencyMs: Date.now() - started };
    } catch {
      res.status(503);
      return { status: 'unavailable', database: 'unreachable' };
    }
  }

  @Public()
  @Get('metrics')
  async metrics(@Headers('authorization') authorization: string | undefined, @Res() res: Response) {
    const token = config().METRICS_TOKEN;
    if (token && !(authorization && safeEqual(authorization, `Bearer ${token}`))) throw Errors.unauthenticated();
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
