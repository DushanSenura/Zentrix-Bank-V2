import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { bearer, boot, makeCustomer, makeLedgerAccount, makeStaff, TEST_DB, type Ctx } from './helpers';

describe.skipIf(!TEST_DB)('accounts: applications, approval, ledger-backed balances (real database)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const decide = (staffToken: string, id: string, body: object) => ctx.http.post(`/api/v1/admin/account-applications/${id}/decision`).set(bearer(staffToken)).send(body);

  it('Phase 3 acceptance: staff approves a new account and the customer sees a ledger-backed balance', async () => {
    const cust = await makeCustomer(ctx, 'acc1');
    const officer = await makeStaff(ctx, 'officer1', 'ACCOUNT_OFFICER');

    const apply = await ctx.http.post('/api/v1/account-applications').set(bearer(cust.token)).send({ productCode: 'SAVINGS_STD', nickname: 'Rainy day' });
    expect(apply.status).toBe(201);
    expect((await ctx.http.get('/api/v1/accounts').set(bearer(cust.token))).body.items).toHaveLength(0); // nothing until staff approve

    const queue = await ctx.http.get('/api/v1/admin/account-applications').set(bearer(officer.token));
    expect(queue.body.items.some((i: { id: string }) => i.id === apply.body.id)).toBe(true);

    expect((await decide(officer.token, apply.body.id, { decision: 'APPROVE', openingDepositMinor: 5000 })).status).toBe(400); // below product minimum
    expect((await decide(officer.token, apply.body.id, { decision: 'REJECT' })).status).toBe(400); // reason required
    const ok = await decide(officer.token, apply.body.id, { decision: 'APPROVE', openingDepositMinor: 250000 });
    expect(ok.status).toBe(201);
    expect((await decide(officer.token, apply.body.id, { decision: 'APPROVE', openingDepositMinor: 250000 })).status).toBe(409); // not re-decidable

    const list = (await ctx.http.get('/api/v1/accounts').set(bearer(cust.token))).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ nickname: 'Rainy day', balanceMinor: 250000, status: 'ACTIVE', kind: 'SAVINGS' });
    expect(list.items[0].accountNumberMasked).toMatch(/^\*{7}\d{4}$/);
    expect(list.totalBalanceMinor).toBe(250000);

    // the balance equals the sum of ledger postings, and history comes from them
    const tx = (await ctx.http.get(`/api/v1/accounts/${list.items[0].id}/transactions`).set(bearer(cust.token))).body;
    expect(tx.items).toHaveLength(1);
    expect(tx.items[0]).toMatchObject({ kind: 'ACCOUNT_OPENING', amountMinor: 250000 });
    expect((await ctx.http.get('/api/v1/admin/reconciliation').set(bearer(officer.token))).status).toBe(403); // officer lacks transactions.read
    expect(await ctx.prisma.auditLog.count({ where: { action: 'account.application_approved', actorId: officer.id } })).toBe(1);
    expect(await ctx.prisma.outboxEvent.count({ where: { topic: 'account.opened' } })).toBeGreaterThan(0);
  });

  it('approval is atomic: if the ledger post fails nothing is created', async () => {
    const cust = await makeCustomer(ctx, 'atomic');
    const officer = await makeStaff(ctx, 'officer2', 'ACCOUNT_OFFICER');
    const apply = await ctx.http.post('/api/v1/account-applications').set(bearer(cust.token)).send({ productCode: 'CURRENT_STD' });
    const ledger = ctx.app.get(LedgerService);
    const original = ledger.post.bind(ledger);
    (ledger as { post: unknown }).post = async () => { throw new Error('simulated ledger outage'); };
    try {
      expect((await decide(officer.token, apply.body.id, { decision: 'APPROVE', openingDepositMinor: 100000 })).status).toBe(500);
    } finally {
      (ledger as { post: unknown }).post = original;
    }
    const app = await ctx.prisma.accountApplication.findUniqueOrThrow({ where: { id: apply.body.id } });
    expect(app.status).toBe('SUBMITTED'); // rolled back, still reviewable
    expect(await ctx.prisma.account.count({ where: { customerId: cust.id } })).toBe(0);
    expect((await decide(officer.token, apply.body.id, { decision: 'APPROVE', openingDepositMinor: 100000 })).status).toBe(201); // retry works
  });

  it('enforces the account limit, verified-customer rule and staff permissions', async () => {
    const pending = await makeCustomer(ctx, 'unverified', { active: false });
    expect((await ctx.http.post('/api/v1/account-applications').set(bearer(pending.token)).send({ productCode: 'SAVINGS_STD' })).status).toBe(403);
    expect((await ctx.http.get('/api/v1/accounts').set(bearer(pending.token))).status).toBe(403);

    const cust = await makeCustomer(ctx, 'limit');
    await ctx.prisma.systemConfiguration.upsert({ where: { key: 'accounts.maxPerCustomer' }, update: { value: 2 }, create: { key: 'accounts.maxPerCustomer', value: 2 } });
    try {
      expect((await ctx.http.post('/api/v1/account-applications').set(bearer(cust.token)).send({ productCode: 'SAVINGS_STD' })).status).toBe(201);
      expect((await ctx.http.post('/api/v1/account-applications').set(bearer(cust.token)).send({ productCode: 'CURRENT_STD' })).status).toBe(201);
      expect((await ctx.http.post('/api/v1/account-applications').set(bearer(cust.token)).send({ productCode: 'SAVINGS_STD' })).status).toBe(409);
    } finally {
      await ctx.prisma.systemConfiguration.delete({ where: { key: 'accounts.maxPerCustomer' } });
    }
    expect((await ctx.http.post('/api/v1/account-applications').set(bearer(cust.token)).send({ productCode: 'NOPE' })).status).toBe(404);

    const auditor = await makeStaff(ctx, 'auditor1', 'AUDITOR');
    expect((await ctx.http.get('/api/v1/admin/account-applications').set(bearer(auditor.token))).status).toBe(403);
    expect((await ctx.http.get('/api/v1/admin/account-applications').set(bearer(cust.token))).status).toBe(403); // customer on staff route
  });

  it('Scenario G: a customer cannot read another customer’s account or history; a security event is recorded', async () => {
    const a = await makeCustomer(ctx, 'ownera');
    const b = await makeCustomer(ctx, 'ownerb');
    const acc = await makeLedgerAccount(ctx, a.id, 1000n);
    expect((await ctx.http.get(`/api/v1/accounts/${acc.id}`).set(bearer(a.token))).status).toBe(200);
    expect((await ctx.http.get(`/api/v1/accounts/${acc.id}`).set(bearer(b.token))).status).toBe(404);
    expect((await ctx.http.get(`/api/v1/accounts/${acc.id}/transactions`).set(bearer(b.token))).status).toBe(404);
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: b.id } })).toBe(2);
    expect((await ctx.http.get('/api/v1/accounts').set(bearer(b.token))).body.items).toHaveLength(0);
    expect((await ctx.http.get(`/api/v1/accounts/not-a-uuid`).set(bearer(a.token))).status).toBe(400);
  });

  it('paginates history with a stable keyset cursor', async () => {
    const c = await makeCustomer(ctx, 'pager');
    const acc = await makeLedgerAccount(ctx, c.id, 100000n);
    const other = await makeLedgerAccount(ctx, c.id, 0n);
    const ledger = ctx.app.get(LedgerService);
    for (let i = 0; i < 6; i++)
      await ledger.post({ reference: `PG-${acc.id}-${i}`, kind: 'TEST', currency: 'LKR', postings: [
        { ledgerAccountId: acc.ledgerAccount!.id, direction: 'DEBIT', amountMinor: 100n, currency: 'LKR' },
        { ledgerAccountId: other.ledgerAccount!.id, direction: 'CREDIT', amountMinor: 100n, currency: 'LKR' } ] });
    const get = (cursor?: string) => ctx.http.get(`/api/v1/accounts/${acc.id}/transactions`).query({ limit: 3, ...(cursor ? { cursor } : {}) }).set(bearer(c.token));
    const p1 = (await get()).body;
    const p2 = (await get(p1.nextCursor)).body;
    const p3 = (await get(p2.nextCursor)).body;
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i: { id: string }) => i.id);
    expect(ids).toHaveLength(7); // 6 debits + opening
    expect(new Set(ids).size).toBe(7);
    expect(p3.nextCursor).toBeNull();
    expect(p1.items[0].amountMinor).toBe(-100); // newest first, money out is negative
    expect((await get('garbage')).status).toBe(400);
  });

  it('staff freeze blocks debits; close needs a zero balance; transitions are validated and audited', async () => {
    const c = await makeCustomer(ctx, 'frz');
    const acc = await makeLedgerAccount(ctx, c.id, 5000n);
    const peer = await makeLedgerAccount(ctx, c.id, 0n);
    const officer = await makeStaff(ctx, 'officer3', 'ACCOUNT_OFFICER');
    const csr = await makeStaff(ctx, 'csr1', 'CUSTOMER_SERVICE');
    const ledger = ctx.app.get(LedgerService);
    const status = (token: string, to: string, reasonCode = 'FRAUD_REVIEW') => ctx.http.post(`/api/v1/admin/accounts/${acc.id}/status`).set(bearer(token)).send({ status: to, reasonCode });

    expect((await status(csr.token, 'FROZEN')).status).toBe(403); // CSR cannot manage accounts
    expect((await status(officer.token, 'FROZEN', 'x')).status).toBe(400); // reason code required
    expect((await status(officer.token, 'FROZEN')).status).toBe(201);
    await expect(ledger.post({ reference: `FRZ-${acc.id}`, kind: 'T', currency: 'LKR', postings: [
      { ledgerAccountId: acc.ledgerAccount!.id, direction: 'DEBIT', amountMinor: 10n, currency: 'LKR' },
      { ledgerAccountId: peer.ledgerAccount!.id, direction: 'CREDIT', amountMinor: 10n, currency: 'LKR' } ] })).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect((await status(officer.token, 'CLOSED')).status).toBe(409); // balance not zero
    expect((await status(officer.token, 'ACTIVE', 'CLEARED')).status).toBe(201);
    await ledger.post({ reference: `DRAIN-${acc.id}`, kind: 'T', currency: 'LKR', postings: [
      { ledgerAccountId: acc.ledgerAccount!.id, direction: 'DEBIT', amountMinor: 5000n, currency: 'LKR' },
      { ledgerAccountId: peer.ledgerAccount!.id, direction: 'CREDIT', amountMinor: 5000n, currency: 'LKR' } ] });
    expect((await status(officer.token, 'CLOSED', 'CUSTOMER_REQUEST')).status).toBe(201);
    expect((await status(officer.token, 'ACTIVE', 'REOPEN')).status).toBe(409); // closed is final
    expect(await ctx.prisma.accountStatusHistory.count({ where: { accountId: acc.id } })).toBe(3);
    expect(await ctx.prisma.auditLog.count({ where: { subjectId: acc.id, actorId: officer.id } })).toBe(3);
    expect((await ctx.http.get('/api/v1/accounts').set(bearer(c.token))).body.items.map((i: { id: string }) => i.id)).not.toContain(acc.id); // closed accounts drop off the list
  });

  it('compliance can run reconciliation and it is clean after all of the above', async () => {
    const comp = await makeStaff(ctx, 'comp1', 'COMPLIANCE_OFFICER');
    const r = await ctx.http.get('/api/v1/admin/reconciliation').set(bearer(comp.token));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
