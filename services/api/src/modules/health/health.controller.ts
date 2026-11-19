import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { loadEnv } from '../../config/env';

type Check = { status: 'up' | 'down'; latencyMs?: number };

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly prisma = new PrismaClient();
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(loadEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    this.redis.on('error', () => undefined); // reported via the health result, not crashed on
  }

  /** Liveness: the process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. 503 when any is down. */
  @Get()
  async ready() {
    const db = await this.time(async () => this.prisma.$queryRaw`SELECT 1`);
    const redis = await this.time(async () => {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.ping();
    });
    const body = { status: db.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded', checks: { database: db, redis } };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  private async time(fn: () => Promise<unknown>): Promise<Check> {
    const t = Date.now();
    try {
      await fn();
      return { status: 'up', latencyMs: Date.now() - t };
    } catch {
      return { status: 'down' };
    }
  }
}
