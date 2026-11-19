/**
 * Zentrix background worker (BullMQ).
 * Phase 1: outbox relay skeleton + heartbeat. Later phases add scheduled transfers, FD maturity,
 * interest posting, loan due dates, reminders and reconciliation. Every processor MUST be idempotent
 * and restart-safe: a job may run more than once and must never double-post money.
 */
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

try {
  process.loadEnvFile('../../.env');
} catch {
  /* rely on process environment */
}

const redisUrl = process.env.REDIS_URL;
if (!process.env.DATABASE_URL || !redisUrl) {
  console.error('DATABASE_URL and REDIS_URL are required');
  process.exit(1);
}

const prisma = new PrismaClient();
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const OUTBOX_QUEUE = 'outbox-relay';
const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });

/**
 * Claims a batch of unpublished outbox events with SKIP LOCKED so multiple workers never double-process,
 * then marks them published. Real delivery (notifications, push) is added in Phase 8.
 */
export async function relayOutboxBatch(limit = 50): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;
    await tx.outboxEvent.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { publishedAt: new Date(), attempts: { increment: 1 } },
    });
    return rows.length;
  });
}

const worker = new Worker(
  OUTBOX_QUEUE,
  async () => {
    const n = await relayOutboxBatch();
    if (n > 0) console.log(`outbox: relayed ${n} event(s)`);
  },
  { connection },
);

worker.on('failed', (job, err) => console.error(`job ${job?.id} failed: ${err.message}`));

async function main() {
  // Repeatable job: same jobId => no duplicate schedules across restarts.
  await outboxQueue.upsertJobScheduler('outbox-tick', { every: 5000 });
  console.log('Zentrix worker started');
}

async function shutdown() {
  await worker.close();
  await outboxQueue.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
