/**
 * Zentrix background worker (BullMQ).
 *  - outbox relay: delivers in-app notifications from outbox events (exactly once, see outbox.ts)
 *  - due-payments tick: asks the API to run scheduled / recurring payments. The API owns all banking logic, so the
 *    worker never touches balances; it only triggers an idempotent, row-locked job.
 * Every processor MUST be idempotent and restart-safe: a job may run more than once and must never double-post money.
 */
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { relayOutboxBatch } from './outbox';

try {
  process.loadEnvFile('../../.env');
} catch {
  /* rely on process environment */
}

const redisUrl = process.env.REDIS_URL;
const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3000';
const jobToken = process.env.INTERNAL_JOB_TOKEN;
if (!process.env.DATABASE_URL || !redisUrl) {
  console.error('DATABASE_URL and REDIS_URL are required');
  process.exit(1);
}
if (!jobToken) console.warn('INTERNAL_JOB_TOKEN is not set: scheduled payments will NOT run');

const prisma = new PrismaClient();
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const OUTBOX_QUEUE = 'outbox-relay';
const DUE_QUEUE = 'due-payments';
const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });
const dueQueue = new Queue(DUE_QUEUE, { connection });

const outboxWorker = new Worker(
  OUTBOX_QUEUE,
  async () => {
    const r = await relayOutboxBatch(prisma);
    if (r.events > 0) console.log(`outbox: ${r.events} event(s), ${r.notifications} notification(s)`);
  },
  { connection },
);

const dueWorker = new Worker(
  DUE_QUEUE,
  async () => {
    if (!jobToken) return;
    const res = await fetch(`${apiBase}/api/v1/internal/jobs/run-due`, { method: 'POST', headers: { 'x-internal-token': jobToken }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`run-due responded ${res.status}`); // BullMQ records the failure; the next tick retries
    const r = (await res.json()) as Record<string, number | string[]>;
    const active = Object.values(r).some((v) => (Array.isArray(v) ? v.length > 0 : v > 0));
    if (active) console.log('due-jobs:', JSON.stringify(r)); // includes any per-job errors reported by the API
  },
  { connection, concurrency: 1 },
);

for (const w of [outboxWorker, dueWorker]) w.on('failed', (job, err) => console.error(`job ${job?.id} failed: ${err.message}`));

async function main() {
  // Same scheduler id => no duplicate schedules across restarts.
  await outboxQueue.upsertJobScheduler('outbox-tick', { every: 5000 });
  await dueQueue.upsertJobScheduler('due-tick', { every: 30_000 });
  console.log('Zentrix worker started');
}

async function shutdown() {
  await Promise.all([outboxWorker.close(), dueWorker.close()]);
  await Promise.all([outboxQueue.close(), dueQueue.close()]);
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
