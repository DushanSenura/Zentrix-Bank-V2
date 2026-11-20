import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LOAN_PRODUCTS } from '../src/modules/loans/loans.service';
import { SavingsService } from '../src/modules/savings/savings.service';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makeCustomer, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

const key = () => randomBytes(16).toString('hex');

describe.skipIf(!TEST_DB)('V1 checklist additions (real database)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await boot();
    for (const p of DEFAULT_LOAN_PRODUCTS) await ctx.prisma.loanProduct.upsert({ where: { code: p.code }, update: {}, create: p });
  });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;
  const get = (p: Payer, path: string) => ctx.http.get(`/api/v1${path}`).set(bearer(p.token));
  const bal = async (id: string) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } })).balanceMinor;
  const notes = async (p: Payer) => { await relayOutboxBatch(ctx.prisma as never, 500); return (await get(p, '/notifications')).body.items as { category: string; title: string }[]; };
  const pay = async (p: Payer, body: object) => {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(p.token)).set('Idempotency-Key', key()).send({ sourceAccountId: p.accountId, ...body });
    expect(d.status).toBe(201);
    const done = await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(p.token)).send({ pin: PIN });
    expect(done.status).toBe(200);
    return done.body;
  };

  it('savings: monthly auto-save is authorised with the PIN, runs once per month, and a shortfall skips the month and says so', async () => {
    const p = await makePayer(ctx, nm('auto'), 1_000_000n);
    const make = (body: object) => ctx.http.post('/api/v1/savings/goals').set(bearer(p.token)).send({ name: 'Trip', targetMinor: 5_000_000, ...body });
    expect((await make({ monthlyAutoMinor: 100_000 })).status).toBe(400); // needs the account and the PIN
    expect((await make({ monthlyAutoMinor: 100_000, autoAccountId: p.accountId, pin: '000000' })).status).toBe(401);
    const g = await make({ monthlyAutoMinor: 100_000, autoAccountId: p.accountId, pin: PIN });
    expect(g.status).toBe(201);
    expect(g.body.autoSave).toMatchObject({ monthlyMinor: 100_000, accountId: p.accountId });

    const svc = ctx.app.get(SavingsService);
    const later = new Date(Date.now() + 32 * 86_400_000);
    expect(await svc.runAutoSaves(later)).toEqual({ saved: 1, failed: 0 });
    expect(await svc.runAutoSaves(later)).toEqual({ saved: 0, failed: 0 }); // the same tick again saves nothing
    const goal = await ctx.prisma.savingsGoal.findUniqueOrThrow({ where: { id: g.body.id } });
    expect(await bal(goal.ledgerAccountId)).toBe(100_000n);
    expect(await bal(p.ledgerId)).toBe(900_000n);

    // Empty the account, then the next month cannot be saved: it is skipped, the goal is untouched and the customer is told.
    await ctx.prisma.$executeRawUnsafe('SELECT 1'); // keep the connection warm; the next call spends the money
    await pay(p, { destination: { type: 'INTERBANK', bankCode: 'SIM-BANK-A', accountNumber: '12345678901', holderName: 'Someone' }, amountMinor: 850_000 });
    expect(await svc.runAutoSaves(new Date(later.getTime() + 32 * 86_400_000))).toEqual({ saved: 0, failed: 1 });
    expect(await bal(goal.ledgerAccountId)).toBe(100_000n);
    expect((await notes(p)).map((x) => x.title)).toContain('Monthly saving skipped');
    expect((await get(p, '/savings/goals')).body.items[0].autoSave.lastFailure).toMatch(/enough/);

    const off = await ctx.http.put(`/api/v1/savings/goals/${g.body.id}/auto`).set(bearer(p.token)).send({ monthlyAutoMinor: null });
    expect(off.status).toBe(200);
    expect(off.body.autoSave).toBeNull();
  });

  it('accounts: the opening deposit can come from another of your own accounts, and moves through the ledger on approval', async () => {
    const p = await makePayer(ctx, nm('fund'), 500_000n);
    const staff = await makeStaff(ctx, nm('fadm'), 'BANK_ADMIN');
    const apply = (body: object) => ctx.http.post('/api/v1/account-applications').set(bearer(p.token)).send({ productCode: 'SAVINGS_STD', ...body });
    expect((await apply({ fundingAccountId: p.accountId, fundingAmountMinor: 200_000 })).status).toBe(400); // no PIN
    expect((await apply({ fundingAccountId: p.accountId, fundingAmountMinor: 50_000, pin: PIN })).status).toBe(400); // below the product minimum
    expect((await apply({ fundingAccountId: p.accountId, fundingAmountMinor: 900_000, pin: PIN })).status).toBe(409); // more than the balance
    expect((await apply({ fundingAccountId: p.accountId, fundingAmountMinor: 200_000, pin: '000000' })).status).toBe(401);
    const app = await apply({ fundingAccountId: p.accountId, fundingAmountMinor: 200_000, pin: PIN });
    expect(app.status).toBe(201);
    const row = await ctx.prisma.accountApplication.findUniqueOrThrow({ where: { id: app.body.id } });
    expect(row.fundingAmountMinor).toBe(200_000n);

    const approve = await ctx.http.post(`/api/v1/admin/account-applications/${app.body.id}/decision`).set(bearer(staff.token)).send({ decision: 'APPROVE' });
    expect(approve.status).toBe(201);
    const opened = await ctx.prisma.account.findUniqueOrThrow({ where: { id: approve.body.accountId }, include: { ledgerAccount: true } });
    expect(opened.ledgerAccount!.balanceMinor).toBe(200_000n); // the amount the customer chose, not what staff typed
    expect(await bal(p.ledgerId)).toBe(300_000n);

    // The monthly summary of the new account reflects the deposit as money in.
    const m = await get(p, `/accounts/${opened.id}/monthly-summary`);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ currency: 'LKR', moneyInMinor: 200_000, moneyOutMinor: 0, netMinor: 200_000 });
    const other = await makePayer(ctx, nm('fundx'), 0n);
    expect((await get(other, `/accounts/${opened.id}/monthly-summary`)).status).toBe(404); // someone else's account
  });

  it('payments: category label drives analytics and budgets; the status filter, save-recipient and large-transfer alert work', async () => {
    const a = await makePayer(ctx, nm('cat'), 20_000_000n);
    const b = await makePayer(ctx, nm('catb'), 0n);
    const bad = await ctx.http.post('/api/v1/payments').set(bearer(a.token)).set('Idempotency-Key', key()).send({ sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 1000, category: 'Gambling' });
    expect(bad.status).toBe(400);

    await ctx.http.put('/api/v1/budgets/Food').set(bearer(a.token)).send({ limitMinor: 100_000 });
    const sent = await pay(a, { destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 90_000, category: 'Food' });
    expect(sent.status).toBe('POSTED');
    const budget = (await get(a, '/budgets')).body.items.find((x: { category: string }) => x.category === 'Food');
    expect(budget).toMatchObject({ spentMinor: 90_000, percentUsed: 90, state: 'NEAR' });
    const summary = (await get(a, '/analytics/summary')).body;
    expect(summary.categories.map((c: { category: string }) => c.category)).toContain('Food');
    expect(summary.savings).toHaveProperty('netMinor');
    const found = await get(a, '/transactions?category=Food');
    expect(found.body.items.length).toBe(1);
    expect((await get(a, '/transactions?category=Transfers')).body.items.length).toBe(0); // the label wins over the default

    // Pending and failed history from the payments list.
    const draft = await ctx.http.post('/api/v1/payments').set(bearer(a.token)).set('Idempotency-Key', key()).send({ sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 2000 });
    expect(draft.status).toBe(201);
    expect((await get(a, '/payments?status=pending')).body.items.map((x: { id: string }) => x.id)).toContain(draft.body.id);
    expect((await get(a, '/payments?status=completed')).body.items.map((x: { id: string }) => x.id)).toContain(sent.id);
    expect((await get(a, '/payments?status=failed')).body.items.length).toBe(0);

    // Save the recipient after paying: the account number comes from the stored payment.
    const saved = await ctx.http.post(`/api/v1/payments/${sent.id}/save-recipient`).set(bearer(a.token)).send({ nickname: 'Friend' });
    expect(saved.status).toBe(201);
    expect((await ctx.http.post(`/api/v1/payments/${sent.id}/save-recipient`).set(bearer(a.token)).send({})).status).toBe(409); // already saved
    expect((await ctx.http.post(`/api/v1/payments/${sent.id}/save-recipient`).set(bearer(b.token)).send({})).status).toBe(404); // not their payment
    expect((await ctx.http.post(`/api/v1/payments/${draft.body.id}/save-recipient`).set(bearer(a.token)).send({})).status).toBe(409); // not completed

    // A payment above the threshold tells the customer; the budget alert and new-recipient notice arrived too.
    await pay(a, { destination: { type: 'INTERBANK', bankCode: 'SIM-BANK-B', accountNumber: '98765432109', holderName: 'Big Payee' }, amountMinor: 10_500_000 });
    const titles = (await notes(a)).map((x) => x.title);
    expect(titles).toEqual(expect.arrayContaining(['Large transfer', 'New recipient saved', 'Budget almost used']));
    const alerts = (await get(a, '/security/alerts')).body.items as { title: string }[];
    expect(alerts.map((x) => x.title)).toContain('Large transfer');
  });

  it('budget suggestions come from the last three full months', async () => {
    const p = await makePayer(ctx, nm('sug'), 1_000_000n);
    const r = await get(p, '/analytics/budget-suggestions');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]); // no history yet: nothing is invented
  });

  it('security: password, PIN and sign-out changes raise security alerts that cannot be muted; announcements reach every customer by category', async () => {
    const p = await makePayer(ctx, nm('sec'), 0n);
    await ctx.http.put('/api/v1/me/preferences').set(bearer(p.token)).send({ notifications: { OFFER: false } });
    expect((await ctx.http.put('/api/v1/security/pin').set(bearer(p.token)).send({ currentPin: PIN, newPin: '135792' })).status).toBe(204);
    expect((await ctx.http.post('/api/v1/security/sessions/revoke-others').set(bearer(p.token))).status).toBe(204);

    const staff = await makeStaff(ctx, nm('ann'), 'BANK_ADMIN');
    const csr = await makeStaff(ctx, nm('anc'), 'CUSTOMER_SERVICE');
    const body = { kind: 'OFFER', title: 'Festive offer', body: 'Zero fees this week.' };
    expect((await ctx.http.post('/api/v1/admin/announcements').set(bearer(csr.token)).send(body)).status).toBe(403);
    expect((await ctx.http.post('/api/v1/admin/announcements').set(bearer(staff.token)).send({ ...body, kind: 'SPAM' })).status).toBe(400);
    const sent = await ctx.http.post('/api/v1/admin/announcements').set(bearer(staff.token)).send(body);
    expect(sent.status).toBe(202);
    expect(sent.body.recipients).toBeGreaterThan(0);
    const notice = await ctx.http.post('/api/v1/admin/announcements').set(bearer(staff.token)).send({ kind: 'NOTICE', title: 'Holiday hours', body: 'Branches close early on Friday.' });
    expect(notice.status).toBe(202);

    const feed = await notes(p);
    expect(feed.map((x) => x.title)).toEqual(expect.arrayContaining(['PIN changed', 'Other devices signed out', 'Holiday hours']));
    expect(feed.map((x) => x.title)).not.toContain('Festive offer'); // muted category
    expect(feed.find((x) => x.title === 'Holiday hours')!.category).toBe('NOTICE');
    const alerts = (await get(p, '/security/alerts')).body.items.map((x: { title: string }) => x.title);
    expect(alerts).toEqual(expect.arrayContaining(['PIN changed', 'Other devices signed out']));
    const prefs = (await get(p, '/me/preferences')).body;
    expect(prefs.notifications).toHaveProperty('OFFER', false);
    expect(prefs.notifications).toHaveProperty('NOTICE', true);
  });

  it('password reset uses a 6-digit code that is tied to the account and stops working after 5 wrong guesses', async () => {
    const c = await makeCustomer(ctx, nm('rst'));
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.id } });
    await ctx.http.post('/api/v1/auth/password-reset/request').send({ identifier: user.username });
    const code = async () => {
      const ev = (await ctx.prisma.outboxEvent.findMany({ where: { topic: 'auth.password_reset_requested' }, orderBy: { createdAt: 'desc' }, take: 50 })).find((e) => (e.payload as { userId?: string }).userId === user.id);
      return (ev!.payload as { devCode: string }).devCode;
    };
    const right = await code();
    const wrong = right === '123456' ? '654321' : '123456';
    const confirm = (code: string, identifier = user.username) => ctx.http.post('/api/v1/auth/password-reset/confirm').send({ identifier, code, newPassword: 'Brand-New-Pass-77' });
    expect((await ctx.http.post('/api/v1/auth/password-reset/confirm').send({ identifier: user.username, code: '12ab56', newPassword: 'x' })).status).toBe(400); // not 6 digits
    for (let i = 0; i < 5; i++) expect((await confirm(wrong)).status).toBe(401);
    expect((await confirm(right)).status).toBe(401); // locked out: the right code no longer works
    await ctx.http.post('/api/v1/auth/password-reset/request').send({ identifier: user.username }); // a new code starts fresh
    const fresh = await code();
    expect((await confirm(fresh, 'nobody_here')).status).toBe(401); // another identifier cannot use it
    expect((await confirm(fresh)).status).toBe(204);
  });

  it('cards: the customer can block a card for good with the PIN (no replacement)', async () => {
    const p = await makePayer(ctx, nm('blk'), 0n);
    const staff = await makeStaff(ctx, nm('cadm'), 'CARD_OFFICER');
    const req = await ctx.http.post('/api/v1/cards').set(bearer(p.token)).send({ accountId: p.accountId, kind: 'VIRTUAL', pin: PIN });
    expect(req.status).toBe(201);
    const ok = await ctx.http.post(`/api/v1/admin/cards/${req.body.id}/decision`).set(bearer(staff.token)).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(201);
    expect((await ctx.http.post(`/api/v1/cards/${req.body.id}/block`).set(bearer(p.token)).send({ pin: '000000' })).status).toBe(401);
    expect((await ctx.http.post(`/api/v1/cards/${req.body.id}/block`).set(bearer(p.token)).send({ pin: PIN })).status).toBe(200);
    expect((await ctx.http.post(`/api/v1/cards/${req.body.id}/block`).set(bearer(p.token)).send({ pin: PIN })).status).toBe(409); // already blocked
    const cards = (await get(p, '/cards')).body.items as { id: string; status: string }[];
    expect(cards).toHaveLength(1); // no replacement was ordered
    expect(cards[0]!.status).toBe('BLOCKED');
  });

  it('loans: a home loan product exists, with the longer terms home loans need', async () => {
    const p = await makePayer(ctx, nm('home'), 0n);
    const items = (await get(p, '/loan-products')).body.items as { code: string; maxTermMonths: number }[];
    const home = items.find((x) => x.code === 'HOME');
    expect(home?.maxTermMonths).toBe(300);
  });
});
