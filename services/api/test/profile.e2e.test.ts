import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makePayer, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

describe.skipIf(!TEST_DB)('profile, preferences and personal limits (real database)', () => {
  let ctx: Ctx;
  const id = randomBytes(3).toString('hex');
  let n = 0;
  const nm = (p: string) => `${p}${n++}${id}`;
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const A = (p: Payer, m: 'get' | 'put' | 'patch' | 'post', path: string, body?: object) => ctx.http[m](`/api/v1${path}`).set(bearer(p.token)).send(body);
  const pay = async (from: Payer, to: Payer, amountMinor: number) => {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(from.token)).set('Idempotency-Key', randomBytes(12).toString('hex')).send({ sourceAccountId: from.accountId, destination: { type: 'ZENTRIX', accountNumber: to.number }, amountMinor });
    if (d.status !== 201) return d; // refused when the draft was created (for example over the daily limit)
    return ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(from.token)).send({ pin: PIN });
  };

  it('shows the customer their own profile, with verified details read-only and the ID never returned', async () => {
    const a = await makePayer(ctx, nm('pro'), 0n);
    const r = await A(a, 'get', '/me/profile');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ canEdit: ['email', 'phone'] });
    expect(r.body.customerNumber).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/nationalIdEnc|passwordHash|pinHash|mfaSecret/);
    expect((await ctx.http.get('/api/v1/me/profile')).status).toBe(401);
  });

  it('contact changes need the PIN, are unique, audited, and notify the customer (strict body: no name or ID edits)', async () => {
    const a = await makePayer(ctx, nm('pc'), 0n);
    const b = await makePayer(ctx, nm('pd'), 0n);
    const email = `new_${id}_${n}@example.test`;
    expect((await A(a, 'patch', '/me/profile', { email })).status).toBe(400); // no PIN
    expect((await A(a, 'patch', '/me/profile', { email, pin: '000000' })).status).toBe(401);
    expect((await A(a, 'patch', '/me/profile', { fullName: 'Someone Else', pin: PIN })).status).toBe(400); // strict
    expect((await A(a, 'patch', '/me/profile', { email: 'not-an-email', pin: PIN })).status).toBe(400);

    const ok = await A(a, 'patch', '/me/profile', { email, phone: '+94 77 123 4567', pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ email, phone: '+94 77 123 4567' });
    expect(await ctx.prisma.auditLog.count({ where: { actorId: a.id, action: 'profile.contact_changed' } })).toBe(1);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await A(a, 'get', '/notifications')).body.items.some((x: { title: string }) => x.title === 'Contact details changed')).toBe(true);
    const taken = await A(b, 'patch', '/me/profile', { email, pin: PIN });
    expect(taken.status).toBe(409); // another customer's email
  });

  it('default account must be the customer\'s own active account; muting categories is honoured, security never muted', async () => {
    const a = await makePayer(ctx, nm('pf'), 100_000n);
    const b = await makePayer(ctx, nm('pg'), 0n);
    expect((await A(a, 'put', '/me/preferences', { defaultAccountId: b.accountId })).status).toBe(404);
    expect((await A(a, 'put', '/me/preferences', { notifications: { SECURITY: false } })).status).toBe(400); // cannot even be expressed
    expect((await A(a, 'put', '/me/preferences', { defaultAccountId: a.accountId, notifications: { TRANSACTION: false } })).status).toBe(200);
    const p = (await A(a, 'get', '/me/preferences')).body;
    expect(p).toMatchObject({ defaultAccountId: a.accountId, alwaysOn: ['SECURITY'] });
    expect(p.notifications).toMatchObject({ TRANSACTION: false, CARD: true });

    // A payment normally notifies the sender (TRANSACTION). Muted: no notification row, but the event is still consumed.
    expect((await pay(a, b, 1_000)).body.status).toBe('POSTED');
    // A security notice still arrives.
    await A(a, 'patch', '/me/profile', { phone: '+94 71 000 1111', pin: PIN });
    await relayOutboxBatch(ctx.prisma as never, 1000);
    const titles = (await A(a, 'get', '/notifications')).body.items.map((x: { title: string; category: string }) => `${x.category}:${x.title}`);
    expect(titles.some((t: string) => t.startsWith('TRANSACTION:'))).toBe(false);
    expect(titles).toContain('SECURITY:Contact details changed');
    // The recipient did not mute anything and is still told.
    expect((await A(b, 'get', '/notifications')).body.items.some((x: { category: string }) => x.category === 'TRANSACTION')).toBe(true);
    // Unmuting restores delivery.
    await A(a, 'put', '/me/preferences', { notifications: { TRANSACTION: true } });
    await pay(a, b, 1_000);
    await relayOutboxBatch(ctx.prisma as never, 1000);
    expect((await A(a, 'get', '/notifications')).body.items.some((x: { category: string }) => x.category === 'TRANSACTION')).toBe(true);
  });

  it('own daily limit: lowering is free and enforced, raising needs the PIN, never above the bank maximum', async () => {
    const a = await makePayer(ctx, nm('lm'), 1_000_000n);
    const b = await makePayer(ctx, nm('ln'), 0n);
    const before = (await A(a, 'get', '/security/limits')).body;
    expect(before).toMatchObject({ customised: false });
    expect(before.dailyMinor).toBe(before.bankMaximumMinor);

    expect((await A(a, 'put', '/security/limits', { dailyMinor: before.bankMaximumMinor + 1 })).status).toBe(422);
    expect((await A(a, 'put', '/security/limits', { dailyMinor: 50 })).status).toBe(400); // below the minimum
    const low = await A(a, 'put', '/security/limits', { dailyMinor: 3_000 }); // lowering needs no PIN
    expect(low.status).toBe(200);
    expect(low.body).toMatchObject({ dailyMinor: 3_000, customised: true });

    expect((await pay(a, b, 2_000)).body.status).toBe('POSTED');
    const over = await pay(a, b, 2_000); // 2,000 + 2,000 > 3,000: the draft is refused up front
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('daily_limit_exceeded');
    expect((await A(a, 'get', '/security/limits')).body.usedTodayMinor).toBe(2_000);

    expect((await A(a, 'put', '/security/limits', { dailyMinor: 10_000 })).status).toBe(422); // raising: PIN required
    expect((await A(a, 'put', '/security/limits', { dailyMinor: 10_000, pin: '000000' })).status).toBe(401);
    const raised = await A(a, 'put', '/security/limits', { dailyMinor: 10_000, pin: PIN });
    expect(raised.status).toBe(200);
    expect((await pay(a, b, 2_000)).body.status).toBe('POSTED');
    expect(await ctx.prisma.auditLog.count({ where: { actorId: a.id, action: 'limits.daily_changed' } })).toBe(2);
    await relayOutboxBatch(ctx.prisma as never, 1000);
    expect((await A(a, 'get', '/notifications')).body.items.filter((x: { title: string }) => x.title === 'Daily transfer limit changed').length).toBe(2);

    // Another customer is unaffected.
    expect((await A(b, 'get', '/security/limits')).body.customised).toBe(false);
  });
});
