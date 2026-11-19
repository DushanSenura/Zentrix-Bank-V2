import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

try {
  process.loadEnvFile('../../.env');
} catch {
  /* CI provides env */
}
const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB; // never the dev database

import { relayOutboxBatch } from '../src/outbox';

describe.skipIf(!TEST_DB)('outbox relay (real database)', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  async function makeUser() {
    const n = Math.random().toString(36).slice(2, 10);
    return prisma.user.create({ data: { type: 'CUSTOMER', username: `wk_${n}`, email: `wk_${n}@t.test`, passwordHash: 'x' } });
  }
  async function drain() {
    // Other suites may leave unpublished events; relay until empty so assertions are about OUR events.
    for (let i = 0; i < 20; i++) if ((await relayOutboxBatch(prisma, 200)).events === 0) break;
  }

  it('creates notifications from events once, and never twice', async () => {
    await drain();
    const a = await makeUser();
    const b = await makeUser();
    await prisma.outboxEvent.create({ data: { topic: 'payment.posted', payload: { notify: [
      { userId: a.id, category: 'TRANSACTION', title: 'Payment sent', body: 'LKR 10.00 sent' },
      { userId: b.id, category: 'TRANSACTION', title: 'Money received', body: 'LKR 10.00 received' } ] } } });
    await prisma.outboxEvent.create({ data: { topic: 'no.notify', payload: { x: 1 } } });

    const first = await relayOutboxBatch(prisma);
    expect(first).toEqual({ events: 2, notifications: 2 });
    expect(await prisma.notification.count({ where: { userId: { in: [a.id, b.id] } } })).toBe(2);
    expect(await relayOutboxBatch(prisma)).toEqual({ events: 0, notifications: 0 });
    expect(await prisma.notification.count({ where: { userId: a.id } })).toBe(1);
  });

  it('concurrent workers never double-deliver', async () => {
    await drain();
    const u = await makeUser();
    for (let i = 0; i < 10; i++) await prisma.outboxEvent.create({ data: { topic: 'payment.posted', payload: { notify: [{ userId: u.id, category: 'TRANSACTION', title: `n${i}`, body: 'b' }] } } });
    await Promise.all([relayOutboxBatch(prisma, 4), relayOutboxBatch(prisma, 4), relayOutboxBatch(prisma, 4), relayOutboxBatch(prisma, 4)]);
    await drain();
    expect(await prisma.notification.count({ where: { userId: u.id } })).toBe(10);
  });

  it('ignores malformed notify entries instead of failing the batch', async () => {
    await drain();
    const u = await makeUser();
    await prisma.outboxEvent.create({ data: { topic: 't', payload: { notify: [{ userId: u.id }, 'junk', { userId: u.id, category: 'C', title: 'ok', body: 'ok' }] } } });
    await relayOutboxBatch(prisma);
    expect(await prisma.notification.count({ where: { userId: u.id } })).toBe(1);
  });
});
