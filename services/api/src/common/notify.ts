import type { Prisma } from '@prisma/client';

export interface Notify {
  userId: string;
  category: 'TRANSACTION' | 'SECURITY' | 'ACCOUNT' | 'CARD' | 'LOAN' | 'DEPOSIT' | 'BUDGET' | 'OFFER' | 'NOTICE';
  title: string;
  body: string;
}

/**
 * Queues in-app notifications through the transactional outbox. Call it with the SAME transaction client as the
 * business change so the notification exists if and only if the change committed. The worker delivers it exactly once.
 */
export async function queueNotifications(db: Prisma.TransactionClient | { outboxEvent: Prisma.TransactionClient['outboxEvent'] }, topic: string, notify: Notify[], extra: Record<string, string> = {}): Promise<void> {
  if (notify.length === 0) return;
  await db.outboxEvent.create({ data: { topic, payload: { ...extra, notify } as unknown as Prisma.InputJsonValue } });
}

/** Whole-number minor units as "LKR 2,500.50" for notification text. */
export function lkr(minor: bigint | number): string {
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}LKR ${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}
