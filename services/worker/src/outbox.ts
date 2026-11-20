import type { PrismaClient } from '@prisma/client';

export interface NotifyItem {
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
 * Push delivery is layered on top by the caller (see push.ts) AFTER this commits, so it can never lose a notification.
 */
export async function relayOutboxBatch(prisma: PrismaClient, limit = 50, after?: (created: NotifyItem[]) => Promise<void>): Promise<{ events: number; notifications: number }> {
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return { events: 0, notifications: 0, created: [] as NotifyItem[] };
    const events = await tx.outboxEvent.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const data: NotifyItem[] = [];
    for (const e of events) {
      const notify = (e.payload as { notify?: unknown } | null)?.notify;
      if (Array.isArray(notify)) data.push(...notify.filter(isNotify));
    }
    // Honour the customer's own choice to mute a category. SECURITY is never muted. The event is still consumed (published),
    // so a muted notification is simply not created rather than retried forever.
    const prefs = await tx.customerPreference.findMany({ where: { customerId: { in: [...new Set(data.map((d) => d.userId))] }, mutedCategories: { isEmpty: false } }, select: { customerId: true, mutedCategories: true } });
    const muted = new Map(prefs.map((p) => [p.customerId, new Set(p.mutedCategories)]));
    const deliver = data.filter((d) => d.category === 'SECURITY' || !muted.get(d.userId)?.has(d.category));
    if (deliver.length) await tx.notification.createMany({ data: deliver });
    await tx.outboxEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
    return { events: events.length, notifications: deliver.length, created: deliver };
  }, { maxWait: 15_000, timeout: 30_000 });
  if (after && result.created.length) await after(result.created).catch(() => undefined); // push is best-effort
  return { events: result.events, notifications: result.notifications };
}
