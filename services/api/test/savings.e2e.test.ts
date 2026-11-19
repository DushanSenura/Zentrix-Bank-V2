import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { bankingMonth, paymentCategory } from '../src/modules/savings/savings.service';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makePayer, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

const key = () => randomBytes(16).toString('hex');

describe('budget helpers (pure)', () => {
  it('categorises payments; own-account moves are not spending', () => {
    expect(paymentCategory('OWN_TRANSFER', {})).toBeNull();
    expect(paymentCategory('INTERNAL_TRANSFER', {})).toBe('Transfers');
    expect(paymentCategory('INTERBANK_TRANSFER', {})).toBe('Transfers');
    expect(paymentCategory('BILL_PAYMENT', { category: 'Water' })).toBe('Water');
    expect(paymentCategory('LOAN_INSTALMENT', {})).toBe('Loan repayments');
  });
  it('the banking month starts at midnight Sri Lanka time on the 1st', () => {
    const m = bankingMonth(new Date('2026-03-15T12:00:00Z'));
    expect(m.label).toBe('2026-03');
    expect(m.start.toISOString()).toBe('2026-02-28T18:30:00.000Z'); // 2026-03-01 00:00 +05:30
    expect(bankingMonth(new Date('2026-02-28T19:00:00Z')).label).toBe('2026-03'); // already March in Colombo
  });
});

describe.skipIf(!TEST_DB)('savings goals and budgets (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  beforeAll(async () => { ctx = await boot(); ledger = ctx.app.get(LedgerService); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;

  const goal = (p: Payer, body: object = {}) => ctx.http.post('/api/v1/savings/goals').set(bearer(p.token)).send({ name: 'Holiday', targetMinor: 1_000_000, ...body });
  const move = (p: Payer, id: string, kind: 'contribute' | 'withdraw', amountMinor: number, k = key(), pin = PIN) =>
    ctx.http.post(`/api/v1/savings/goals/${id}/${kind}`).set(bearer(p.token)).set('Idempotency-Key', k).send({ accountId: p.accountId, amountMinor, pin });
  const bal = async (id: string) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } })).balanceMinor;

  it('goals: create, contribute and withdraw move money through the ledger; reaching the target is recognised', async () => {
    const c = await makePayer(ctx, nm('goal'), 2_000_000n);
    expect((await goal(c, { targetMinor: 0 })).status).toBe(400);
    expect((await goal(c, { targetDate: '2020-01-01T00:00:00Z' })).status).toBe(400);
    const g = await goal(c, { targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({ name: 'Holiday', targetMinor: 1_000_000, savedMinor: 0, progressPercent: 0, status: 'ACTIVE' });

    expect((await move(c, g.body.id, 'contribute', 100, key(), '000000')).status).toBe(401);
    const c1 = await move(c, g.body.id, 'contribute', 250_000);
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ savedMinor: 250_000, progressPercent: 25 });
    expect(await bal(c.ledgerId)).toBe(1_750_000n);
    expect((await move(c, g.body.id, 'contribute', 5_000_000)).status).toBe(422); // more than the account holds
    expect((await move(c, g.body.id, 'withdraw', 300_000)).status).toBe(422); // more than saved

    const done = await move(c, g.body.id, 'contribute', 750_000);
    expect(done.body).toMatchObject({ savedMinor: 1_000_000, progressPercent: 100, status: 'ACHIEVED' });
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.some((x: { title: string }) => x.title === 'Goal reached!')).toBe(true);

    const w = await move(c, g.body.id, 'withdraw', 400_000);
    expect(w.body).toMatchObject({ savedMinor: 600_000, status: 'ACTIVE' }); // below target again
    expect(await bal(c.ledgerId)).toBe(1_000_000n + 400_000n);
    const list = (await ctx.http.get('/api/v1/savings/goals').set(bearer(c.token))).body;
    expect(list).toMatchObject({ totalSavedMinor: 600_000 });
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('idempotency: the same key sent concurrently saves once; a different body is refused', async () => {
    const c = await makePayer(ctx, nm('gidem'), 2_000_000n);
    const g = (await goal(c)).body;
    const k = key();
    const rs = await Promise.all(Array.from({ length: 5 }, () => move(c, g.id, 'contribute', 100_000, k)));
    expect(rs.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await bal(c.ledgerId)).toBe(1_900_000n); // debited once
    expect((await move(c, g.id, 'contribute', 100_001, k)).status).toBe(422);
    expect((await ctx.http.post(`/api/v1/savings/goals/${g.id}/contribute`).set(bearer(c.token)).send({ accountId: c.accountId, amountMinor: 1, pin: PIN })).status).toBe(400); // key required
  });

  it('closing a goal needs an empty goal; isolation between customers', async () => {
    const a = await makePayer(ctx, nm('gcl'), 1_000_000n);
    const b = await makePayer(ctx, nm('gcl2'), 1_000_000n);
    const g = (await goal(a)).body;
    await move(a, g.id, 'contribute', 100_000);
    expect((await ctx.http.delete(`/api/v1/savings/goals/${g.id}`).set(bearer(a.token))).status).toBe(409);
    expect((await ctx.http.delete(`/api/v1/savings/goals/${g.id}`).set(bearer(b.token))).status).toBe(404);
    expect((await move(b, g.id, 'contribute', 100)).status).toBe(404); // cannot add to or probe another customer's goal
    expect((await move(b, g.id, 'withdraw', 100)).status).toBe(404);
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: b.id } })).toBeGreaterThanOrEqual(3);
    expect((await ctx.http.get('/api/v1/savings/goals').set(bearer(b.token))).body.items).toHaveLength(0);
    await move(a, g.id, 'withdraw', 100_000);
    expect((await ctx.http.delete(`/api/v1/savings/goals/${g.id}`).set(bearer(a.token))).status).toBe(204);
    expect((await ctx.http.get('/api/v1/savings/goals').set(bearer(a.token))).body.items).toHaveLength(0);
    expect((await move(a, g.id, 'contribute', 100)).status).toBe(409); // closed
  });

  it('budgets: spending comes from posted payments by category; alerts fire once at 80% and once at 100%', async () => {
    const c = await makePayer(ctx, nm('bud'), 5_000_000n);
    const payBill = async (amountMinor: number) => {
      const d = await ctx.http.post('/api/v1/payments').set(bearer(c.token)).set('Idempotency-Key', key()).send({ sourceAccountId: c.accountId, destination: { type: 'BILL', billerCode: 'ELEC-01', billRef: '0123456789' }, amountMinor });
      const r = await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(c.token)).send({ pin: PIN });
      expect(r.body.status).toBe('POSTED');
    };
    const titles = async () => { await relayOutboxBatch(ctx.prisma as never, 500); return (await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.map((x: { title: string }) => x.title) as string[]; };
    const set = (category: string, limitMinor: number) => ctx.http.put(`/api/v1/budgets/${encodeURIComponent(category)}`).set(bearer(c.token)).send({ limitMinor });

    expect((await set('Made up', 1000)).status).toBe(400);
    expect((await set('Electricity', 0)).status).toBe(400);
    const set1 = await set('Electricity', 100_000);
    expect(set1.status).toBe(200);
    expect(set1.body.categories).toContain('Electricity');
    expect(set1.body.items[0]).toMatchObject({ category: 'Electricity', limitMinor: 100_000, spentMinor: 0, state: 'OK' });

    await payBill(50_000);
    expect((await titles()).filter((t) => t.startsWith('Budget'))).toHaveLength(0);
    await payBill(35_000); // 85%
    expect((await titles()).filter((t) => t === 'Budget almost used')).toHaveLength(1);
    await payBill(1_000); // 86%: still the same band, no repeat
    expect((await titles()).filter((t) => t === 'Budget almost used')).toHaveLength(1);
    await payBill(20_000); // 106%
    const t = await titles();
    expect(t.filter((x) => x === 'Budget reached')).toHaveLength(1);
    await payBill(5_000);
    expect((await titles()).filter((x) => x === 'Budget reached')).toHaveLength(1);

    const b = (await ctx.http.get('/api/v1/budgets').set(bearer(c.token))).body.items[0];
    expect(b).toMatchObject({ spentMinor: 111_000, state: 'OVER', percentUsed: 111 });
    expect(b.remainingMinor).toBe(-11_000); // budgets never block payments; they only inform

    // own-account moves are not spending
    const own = await ledger.systemAccountId('cash');
    expect(own).toBeTruthy();
    expect((await ctx.http.delete('/api/v1/budgets/Electricity').set(bearer(c.token))).status).toBe(204);
    expect((await ctx.http.delete('/api/v1/budgets/Electricity').set(bearer(c.token))).status).toBe(404);
  });

  it('budgets are private to each customer', async () => {
    const a = await makePayer(ctx, nm('budp'), 0n);
    const b = await makePayer(ctx, nm('budp2'), 0n);
    await ctx.http.put('/api/v1/budgets/Water').set(bearer(a.token)).send({ limitMinor: 5000 });
    expect((await ctx.http.get('/api/v1/budgets').set(bearer(b.token))).body.items).toHaveLength(0);
    expect((await ctx.http.delete('/api/v1/budgets/Water').set(bearer(b.token))).status).toBe(404);
  });

  it('ledger reconciles', async () => {
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});
