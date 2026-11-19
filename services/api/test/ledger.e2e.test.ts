import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService, LedgerRejection } from '../src/modules/ledger/ledger.service';
import { LedgerError } from '../src/modules/ledger/money';
import { boot, makeCustomer, makeLedgerAccount, TEST_DB, type Ctx } from './helpers';

describe.skipIf(!TEST_DB)('ledger (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  let n = 0;
  const ref = (p: string) => `${p}-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    ctx = await boot();
    ledger = ctx.app.get(LedgerService);
  });
  afterAll(async () => {
    await ctx.app?.close();
    await ctx.prisma.$disconnect();
  });

  const move = (from: string, to: string, amount: bigint, reference = ref('MV')) =>
    ledger.post({
      reference, kind: 'TEST_TRANSFER', currency: 'LKR',
      postings: [
        { ledgerAccountId: from, direction: 'DEBIT', amountMinor: amount, currency: 'LKR' },
        { ledgerAccountId: to, direction: 'CREDIT', amountMinor: amount, currency: 'LKR' },
      ],
    });
  const bal = async (id: string) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } })).balanceMinor;

  async function pair(a: bigint, b: bigint) {
    const c = await makeCustomer(ctx, ref('c'));
    const x = await makeLedgerAccount(ctx, c.id, a);
    const y = await makeLedgerAccount(ctx, c.id, b);
    return { x: x.ledgerAccount!.id, y: y.ledgerAccount!.id, xa: x, ya: y };
  }

  it('posts a balanced journal, updates the projection and reconciles', async () => {
    const { x, y } = await pair(100000n, 0n);
    await move(x, y, 25050n);
    expect(await bal(x)).toBe(74950n);
    expect(await bal(y)).toBe(25050n);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('rejects unbalanced and mixed-currency journals before touching the database', async () => {
    const { x, y } = await pair(1000n, 0n);
    await expect(ledger.post({ reference: ref('UB'), kind: 'T', currency: 'LKR', postings: [
      { ledgerAccountId: x, direction: 'DEBIT', amountMinor: 100n, currency: 'LKR' },
      { ledgerAccountId: y, direction: 'CREDIT', amountMinor: 99n, currency: 'LKR' } ] })).rejects.toBeInstanceOf(LedgerError);
    await expect(ledger.post({ reference: ref('MC'), kind: 'T', currency: 'LKR', postings: [
      { ledgerAccountId: x, direction: 'DEBIT', amountMinor: 100n, currency: 'LKR' },
      { ledgerAccountId: y, direction: 'CREDIT', amountMinor: 100n, currency: 'USD' } ] })).rejects.toBeInstanceOf(LedgerError);
    expect(await bal(x)).toBe(1000n);
  });

  it('the DATABASE itself rejects an unbalanced journal and any mutation of postings', async () => {
    const { x, y } = await pair(1000n, 0n);
    await expect(ctx.prisma.$transaction(async (tx) => {
      const j = await tx.ledgerJournal.create({ data: { reference: ref('RAW'), kind: 'RAW', currency: 'LKR' } });
      await tx.ledgerPosting.createMany({ data: [
        { journalId: j.id, ledgerAccountId: x, direction: 'DEBIT', amountMinor: 10n, currency: 'LKR' },
        { journalId: j.id, ledgerAccountId: y, direction: 'CREDIT', amountMinor: 9n, currency: 'LKR' } ] });
    })).rejects.toThrow(/unbalanced/i);
    await expect(ctx.prisma.$executeRaw`DELETE FROM "LedgerPosting"`).rejects.toThrow(/append-only/i);
    await expect(ctx.prisma.$executeRaw`UPDATE "LedgerPosting" SET "amountMinor" = 1`).rejects.toThrow(/append-only/i);
  });

  it('refuses to overdraw and leaves no trace', async () => {
    const { x, y } = await pair(500n, 0n);
    const before = await ctx.prisma.ledgerJournal.count();
    await expect(move(x, y, 501n)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await ctx.prisma.ledgerJournal.count()).toBe(before);
    expect(await bal(x)).toBe(500n);
  });

  it('a duplicate reference posts only once', async () => {
    const { x, y } = await pair(1000n, 0n);
    const r = ref('DUP');
    await move(x, y, 100n, r);
    await expect(move(x, y, 100n, r)).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE' });
    expect(await bal(x)).toBe(900n);
  });

  it('Scenario H: 10 concurrent spends of a balance that covers 3 -> exactly 3 succeed, no overspend', async () => {
    const { x, y } = await pair(1000n, 0n);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => move(x, y, 300n)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected' && (r.reason as LedgerRejection).code === 'INSUFFICIENT_FUNDS').length;
    expect(ok).toBe(3);
    expect(refused).toBe(7);
    expect(await bal(x)).toBe(100n);
    expect(await bal(y)).toBe(900n);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('opposite-direction concurrent transfers do not deadlock and conserve money', async () => {
    const { x, y } = await pair(10000n, 10000n);
    const jobs = Array.from({ length: 20 }, (_, i) => (i % 2 ? move(x, y, 10n) : move(y, x, 10n)));
    const results = await Promise.allSettled(jobs);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await bal(x)) + (await bal(y))).toBe(20000n);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('frozen accounts cannot send but can receive; suspended/closed accounts can do neither', async () => {
    const { x, y, xa } = await pair(1000n, 1000n);
    await ctx.prisma.account.update({ where: { id: xa.id }, data: { status: 'FROZEN' } });
    await expect(move(x, y, 10n)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await move(y, x, 10n); // credit into frozen account is allowed
    await ctx.prisma.account.update({ where: { id: xa.id }, data: { status: 'SUSPENDED' } });
    await expect(move(y, x, 10n)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await ctx.prisma.account.update({ where: { id: xa.id }, data: { status: 'CLOSED' } });
    await expect(move(x, y, 10n)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
  });

  it('reversal restores balances with an opposite journal, never edits history, and cannot repeat', async () => {
    const { x, y } = await pair(1000n, 0n);
    const r = ref('REV');
    const posted = await move(x, y, 400n, r);
    const rev = await ledger.reverse(posted.journalId, ref('REVOF'));
    expect(await bal(x)).toBe(1000n);
    expect(await bal(y)).toBe(0n);
    const orig = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { id: posted.journalId }, include: { postings: true } });
    expect(orig.status).toBe('REVERSED');
    expect(orig.postings).toHaveLength(2); // history intact
    expect((await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { id: rev.journalId } })).reversesJournalId).toBe(posted.journalId);
    await expect(ledger.reverse(posted.journalId, ref('REVAGAIN'))).rejects.toMatchObject({ code: 'NOT_REVERSIBLE' });
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('reconciliation DETECTS a tampered projection', async () => {
    const { x } = await pair(1000n, 0n);
    await ctx.prisma.ledgerAccount.update({ where: { id: x }, data: { balanceMinor: 999999n } }); // simulate corruption
    const r = await ledger.reconcile();
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.ledgerAccountId === x && m.computed === '1000')).toBe(true);
    await ctx.prisma.ledgerAccount.update({ where: { id: x }, data: { balanceMinor: 1000n } }); // restore so other tests stay clean
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});
