import type { PrismaClient } from '@prisma/client';

interface NotifyItem {
  userId: string;
  category: string;
  title: string;
  body: string;
}

const isNotify = (x: unknown): x is NotifyItem =>
  !!x && typeof x === 'object' && ['userId', 'category', 'title', 'body'].every((k) => typeof (x as Record<string, unknown>)[k] === 'string');

/**
 * Claims a batch of unpublished outbox events with FOR UPDATE SKIP LOCKED (several workers never double-process),
 * creates the in-app notifications they describe, and marks them published - all in ONE transaction, so a crash
 * either leaves the events untouched (retried) or fully delivered (never duplicated).
 * Push delivery (FCM) is layered on in Phase 8.
 */
export async function relayOutboxBatch(prisma: PrismaClient, limit = 50): Promise<{ events: number; notifications: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return { events: 0, notifications: 0 };
    const events = await tx.outboxEvent.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const data: NotifyItem[] = [];
    for (const e of events) {
      const notify = (e.payload as { notify?: unknown } | null)?.notify;
      if (Array.isArray(notify)) data.push(...notify.filter(isNotify));
    }
    if (data.length) await tx.notification.createMany({ data });
    await tx.outboxEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
    return { events: events.length, notifications: data.length };
  }, { maxWait: 15_000, timeout: 30_000 });
}
