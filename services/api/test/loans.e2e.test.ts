import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { DEFAULT_LOAN_PRODUCTS, LoansService } from '../src/modules/loans/loans.service';
import { buildSchedule, emi } from '../src/modules/loans/amortization';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

const key = () => randomBytes(16).toString('hex');

describe.skipIf(!TEST_DB)('loans (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  let loans: LoansService;
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;

  beforeAll(async () => {
    ctx = await boot();
    for (const p of DEFAULT_LOAN_PRODUCTS) await ctx.prisma.loanProduct.upsert({ where: { code: p.code }, update: {}, create: p });
    ledger = ctx.app.get(LedgerService);
    loans = ctx.app.get(LoansService);
  });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const bal = async (id: string) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } })).balanceMinor;
  const apply = (p: Payer, body: object = {}) =>
    ctx.http.post('/api/v1/loan-applications').set(bearer(p.token)).send({ productCode: 'PERSONAL', amountMinor: 30_000_000, termMonths: 6, monthlyIncomeMinor: 20_000_000, employment: 'Engineer', purpose: 'Home repairs', disbursementAccountId: p.accountId, consent: true, ...body });
  const officer = (name: string) => makeStaff(ctx, nm(name), 'LOAN_OFFICER');

  /** A fully disbursed loan via the real two-person workflow. */
  async function disbursedLoan(p: Payer, body: object = {}) {
    const a = await apply(p, body);
    const maker = await officer('maker');
    const checker = await officer('checker');
    const rec = await ctx.http.post(`/api/v1/admin/loan-applications/${a.body.id}/recommend`).set(bearer(maker.token)).send({});
    const dec = await ctx.http.post(`/api/v1/admin/loan-approvals/${rec.body.approvalRequestId}/decision`).set(bearer(checker.token)).send({ decision: 'APPROVE' });
    expect(dec.status).toBe(201);
    return { loanId: dec.body.loanId as string, applicationId: a.body.id as string, approvalId: rec.body.approvalRequestId as string, maker, checker };
  }
  const pay = async (p: Payer, loanId: string, amountMinor: number) => {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(p.token)).set('Idempotency-Key', key()).send({ sourceAccountId: p.accountId, destination: { type: 'LOAN', loanId }, amountMinor });
    if (d.status !== 201) return d;
    return ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(p.token)).send({ pin: PIN });
  };
  const loanRow = (id: string) => ctx.prisma.loan.findUniqueOrThrow({ where: { id }, include: { schedule: { orderBy: { instalmentNo: 'asc' } } } });

  it('Scenario E: apply -> officer recommends -> a DIFFERENT officer approves -> disbursement posts -> loan and schedule are visible', async () => {
    const c = await makePayer(ctx, nm('loan'), 0n);
    const calc = (await ctx.http.get('/api/v1/loans/calculate?productCode=PERSONAL&amountMinor=30000000&termMonths=6&monthlyIncomeMinor=20000000').set(bearer(c.token))).body;
    expect(calc.emiMinor).toBe(Number(emi(30_000_000n, 1450, 6)));
    expect(calc.eligibility.disclaimer).toMatch(/not an approval/i); // an estimate, never a decision
    expect(calc.eligibility.band).toBeTruthy();

    const a = await apply(c);
    expect(a.status).toBe(201);
    expect(a.body.status).toBe('SUBMITTED');
    expect((await ctx.http.get('/api/v1/loans').set(bearer(c.token))).body.items).toHaveLength(0); // nothing exists until the bank approves
    expect(await bal(c.ledgerId)).toBe(0n);
    const tracker = (await ctx.http.get('/api/v1/loan-applications').set(bearer(c.token))).body.items[0];
    expect(tracker.steps.map((s: { done: boolean }) => s.done)).toEqual([true, false, false, false]);

    const maker = await officer('maker');
    const checker = await officer('checker');
    const queue = await ctx.http.get('/api/v1/admin/loan-applications').set(bearer(maker.token));
    expect(queue.body.items.find((i: { id: string }) => i.id === a.body.id)).toMatchObject({ amountMinor: 30_000_000, termMonths: 6, employment: 'Engineer' });

    expect((await ctx.http.post(`/api/v1/admin/loan-applications/${a.body.id}/recommend`).set(bearer(maker.token)).send({ approvedAmountMinor: 30_000_001 })).status).toBe(400); // cannot exceed the request
    const rec = await ctx.http.post(`/api/v1/admin/loan-applications/${a.body.id}/recommend`).set(bearer(maker.token)).send({ approvedAmountMinor: 25_000_000, conditions: 'Salary slip on file' });
    expect(rec.status).toBe(201);
    expect((await ctx.http.post(`/api/v1/admin/loan-applications/${a.body.id}/recommend`).set(bearer(maker.token)).send({})).status).toBe(409); // already recommended

    // MAKER-CHECKER: the maker cannot approve their own recommendation
    const self = await ctx.http.post(`/api/v1/admin/loan-approvals/${rec.body.approvalRequestId}/decision`).set(bearer(maker.token)).send({ decision: 'APPROVE' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('maker_checker');
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'MAKER_CHECKER_VIOLATION', userId: maker.id } })).toBe(1);
    expect(await ctx.prisma.loan.count({ where: { customerId: c.id } })).toBe(0);
    expect(await bal(c.ledgerId)).toBe(0n);

    // the checker sees the request, with who made it
    const pending = (await ctx.http.get('/api/v1/admin/loan-approvals').set(bearer(checker.token))).body.items.find((i: { id: string }) => i.id === rec.body.approvalRequestId);
    expect(pending.requestedBy).toBe(maker.id);
    expect(pending.terms).toMatchObject({ amountMinor: '25000000', termMonths: 6, rateBps: 1450 });

    const dec = await ctx.http.post(`/api/v1/admin/loan-approvals/${rec.body.approvalRequestId}/decision`).set(bearer(checker.token)).send({ decision: 'APPROVE' });
    expect(dec.status).toBe(201);
    expect(dec.body.status).toBe('APPROVED');
    expect((await ctx.http.post(`/api/v1/admin/loan-approvals/${rec.body.approvalRequestId}/decision`).set(bearer(checker.token)).send({ decision: 'APPROVE' })).status).toBe(409);

    // disbursement posted to the ledger
    expect(await bal(c.ledgerId)).toBe(25_000_000n);
    const loan = await loanRow(dec.body.loanId);
    expect(await bal(loan.ledgerAccountId)).toBe(25_000_000n); // outstanding principal
    const j = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { reference: `LOANDISB-${loan.reference}` }, include: { postings: true } });
    expect(j.postings.map((p) => p.direction).sort()).toEqual(['CREDIT', 'DEBIT']);

    // schedule matches the integer amortisation and sums to the principal exactly
    expect(loan.schedule).toHaveLength(6);
    expect(loan.schedule.reduce((s, r) => s + r.principalMinor, 0n)).toBe(25_000_000n);
    const expected = buildSchedule(25_000_000n, 1450, 6, loan.startDate);
    expect(loan.schedule.map((r) => r.interestMinor)).toEqual(expected.map((r) => r.interestMinor));

    const view = (await ctx.http.get(`/api/v1/loans/${loan.id}`).set(bearer(c.token))).body;
    expect(view).toMatchObject({ status: 'ACTIVE', principalMinor: 25_000_000, outstandingPrincipalMinor: 25_000_000, termMonths: 6 });
    expect(view.schedule).toHaveLength(6);
    expect(view.next.instalmentNo).toBe(1);
    expect((await ctx.http.get('/api/v1/loan-applications').set(bearer(c.token))).body.items[0]).toMatchObject({ status: 'DISBURSED', loanId: loan.id });
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.some((x: { title: string }) => x.title === 'Loan approved and paid out')).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'loan.disbursed', actorId: checker.id, subjectId: loan.id } })).toBe(1);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('the DATABASE refuses an approval whose checker equals its maker', async () => {
    const c = await makePayer(ctx, nm('dbmc'), 0n);
    const a = await apply(c);
    const maker = await officer('maker');
    const rec = await ctx.http.post(`/api/v1/admin/loan-applications/${a.body.id}/recommend`).set(bearer(maker.token)).send({});
    await expect(ctx.prisma.approvalRequest.update({ where: { id: rec.body.approvalRequestId }, data: { status: 'APPROVED', decidedBy: maker.id } })).rejects.toThrow(/approval_maker_ne_checker|check constraint/i);
  });

  it('rejections: by the reviewer or by the checker; the customer sees the reason; nothing is created', async () => {
    const c = await makePayer(ctx, nm('lrej'), 0n);
    const maker = await officer('maker');
    const checker = await officer('checker');
    const a1 = await apply(c);
    expect((await ctx.http.post(`/api/v1/admin/loan-applications/${a1.body.id}/reject`).set(bearer(maker.token)).send({ reason: 'x' })).status).toBe(400); // reason must be meaningful
    const rj = await ctx.http.post(`/api/v1/admin/loan-applications/${a1.body.id}/reject`).set(bearer(maker.token)).send({ reason: 'Income not verifiable' });
    expect(rj.body.status).toBe('REJECTED');
    expect((await ctx.http.post(`/api/v1/admin/loan-applications/${a1.body.id}/reject`).set(bearer(maker.token)).send({ reason: 'again again' })).status).toBe(409);

    const a2 = await apply(c);
    const rec = await ctx.http.post(`/api/v1/admin/loan-applications/${a2.body.id}/recommend`).set(bearer(maker.token)).send({});
    expect((await ctx.http.post(`/api/v1/admin/loan-approvals/${rec.body.approvalRequestId}/decision`).set(bearer(checker.token)).send({ decision: 'REJECT' })).status).toBe(400); // reason required
    const cr = await ctx.http.post(`/api/v1/admin/loan-approvals/${rec.body.approvalRequestId}/decision`).set(bearer(checker.token)).send({ decision: 'REJECT', reason: 'Exceeds exposure policy' });
    expect(cr.body.status).toBe('REJECTED');
    const items = (await ctx.http.get('/api/v1/loan-applications').set(bearer(c.token))).body.items;
    expect(items.map((i: { decisionReason: string | null }) => i.decisionReason).sort()).toEqual(['Exceeds exposure policy', 'Income not verifiable']);
    expect(await ctx.prisma.loan.count({ where: { customerId: c.id } })).toBe(0);
  });

  it('validation, limits and permissions', async () => {
    const c = await makePayer(ctx, nm('lval'), 0n);
    expect((await apply(c, { amountMinor: 1_000_000 })).status).toBe(422); // below product minimum
    expect((await apply(c, { termMonths: 120 })).status).toBe(422);
    expect((await apply(c, { consent: false })).status).toBe(400);
    expect((await apply(c, { productCode: 'NOPE' })).status).toBe(404);
    expect((await apply(c, { amountMinor: 30_000_000.5 })).status).toBe(400);
    const other = await makePayer(ctx, nm('lval2'), 0n);
    expect((await apply(c, { disbursementAccountId: other.accountId })).status).toBe(404);
    for (let i = 0; i < 3; i++) expect((await apply(c)).status).toBe(201);
    expect((await apply(c)).status).toBe(409); // too many open applications

    const csr = await makeStaff(ctx, nm('csrl'), 'CUSTOMER_SERVICE');
    const mgr = await makeStaff(ctx, nm('mgr'), 'BRANCH_MANAGER'); // may review, may NOT approve
    expect((await ctx.http.get('/api/v1/admin/loan-applications').set(bearer(csr.token))).status).toBe(403);
    expect((await ctx.http.get('/api/v1/admin/loan-applications').set(bearer(c.token))).status).toBe(403);
    expect((await ctx.http.get('/api/v1/admin/loan-approvals').set(bearer(mgr.token))).status).toBe(403);
    const unverified = await ctx.prisma.customerProfile.update({ where: { userId: c.id }, data: { kycStatus: 'SUBMITTED' } });
    const q = (await ctx.http.get('/api/v1/admin/loan-applications').set(bearer(mgr.token))).body.items.find((i: { customerNumber: string }) => i.customerNumber === unverified.customerNumber);
    expect((await ctx.http.post(`/api/v1/admin/loan-applications/${q.id}/recommend`).set(bearer(mgr.token)).send({})).status).toBe(409); // unverified customer
    await ctx.prisma.customerProfile.update({ where: { userId: c.id }, data: { kycStatus: 'APPROVED' } });
  });

  it('isolation: other customers cannot see or settle someone else\'s loan', async () => {
    const a = await makePayer(ctx, nm('liso'), 0n);
    const b = await makePayer(ctx, nm('liso2'), 5_000_000n);
    const { loanId } = await disbursedLoan(a);
    expect((await ctx.http.get(`/api/v1/loans/${loanId}`).set(bearer(b.token))).status).toBe(404);
    expect((await ctx.http.get(`/api/v1/loans/${loanId}/settlement`).set(bearer(b.token))).status).toBe(404);
    expect((await pay(b, loanId, 100_000)).status).toBe(404); // cannot pay (or probe) another customer's loan
    expect((await ctx.http.get('/api/v1/loans').set(bearer(b.token))).body.items).toHaveLength(0);
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: b.id } })).toBeGreaterThanOrEqual(2);
  });

  it('repayment through the payment pipeline: interest first, then principal; partial payments; ledger split', async () => {
    const c = await makePayer(ctx, nm('lpay'), 0n);
    const { loanId } = await disbursedLoan(c, { amountMinor: 30_000_000, termMonths: 6 });
    // give the customer extra money to repay with
    await ledger.post({ reference: nm('TOPUP'), kind: 'TEST', currency: 'LKR', postings: [
      { ledgerAccountId: await ledger.systemAccountId('cash'), direction: 'DEBIT', amountMinor: 20_000_000n, currency: 'LKR' },
      { ledgerAccountId: c.ledgerId, direction: 'CREDIT', amountMinor: 20_000_000n, currency: 'LKR' } ] });
    let loan = await loanRow(loanId);
    const r1 = loan.schedule[0]!;
    const incomeBefore = (await ctx.prisma.ledgerAccount.findUnique({ where: { code: 'SYS-INTEREST-INCOME-LKR' } }))?.balanceMinor ?? 0n;

    // partial: less than the first instalment's interest -> all interest, no principal
    const half = Number(r1.interestMinor) - 100;
    const p1 = await pay(c, loanId, half);
    expect(p1.body.status).toBe('POSTED');
    expect(p1.body).toMatchObject({ kind: 'LOAN_INSTALMENT' });
    loan = await loanRow(loanId);
    expect(loan.schedule[0]).toMatchObject({ status: 'PARTIAL', paidInterestMinor: BigInt(half), paidPrincipalMinor: 0n });
    expect(await bal(loan.ledgerAccountId)).toBe(30_000_000n); // principal untouched

    // pay the rest of instalment 1 exactly -> PAID, principal reduced by its principal part
    const rest = Number(r1.principalMinor + r1.interestMinor) - half;
    const p2 = await pay(c, loanId, rest);
    expect(p2.body.status).toBe('POSTED');
    loan = await loanRow(loanId);
    expect(loan.schedule[0]!.status).toBe('PAID');
    expect(loan.schedule[1]!.status).toBe('DUE');
    expect(await bal(loan.ledgerAccountId)).toBe(30_000_000n - r1.principalMinor);
    const incomeAfter = (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'SYS-INTEREST-INCOME-LKR' } })).balanceMinor;
    expect(incomeAfter - incomeBefore).toBe(r1.interestMinor); // interest recognised as income, exactly
    const lp = await ctx.prisma.loanPayment.findMany({ where: { loanId }, orderBy: { createdAt: 'asc' } });
    expect(lp.map((x) => [x.principalMinor, x.interestMinor])).toEqual([[0n, BigInt(half)], [r1.principalMinor, r1.interestMinor - BigInt(half)]]);

    const detail = (await ctx.http.get(`/api/v1/loans/${loanId}`).set(bearer(c.token))).body;
    expect(detail.next.instalmentNo).toBe(2);
    expect(detail.payments).toHaveLength(2);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('overpayment is refused up front; paying the settlement amount closes the loan and waives future interest', async () => {
    const c = await makePayer(ctx, nm('lset'), 0n);
    const { loanId } = await disbursedLoan(c, { amountMinor: 20_000_000, termMonths: 12 });
    await ledger.post({ reference: nm('TOPUP'), kind: 'TEST', currency: 'LKR', postings: [
      { ledgerAccountId: await ledger.systemAccountId('cash'), direction: 'DEBIT', amountMinor: 30_000_000n, currency: 'LKR' },
      { ledgerAccountId: c.ledgerId, direction: 'CREDIT', amountMinor: 30_000_000n, currency: 'LKR' } ] });
    const quote = (await ctx.http.get(`/api/v1/loans/${loanId}/settlement`).set(bearer(c.token))).body;
    expect(quote.principalMinor).toBe(20_000_000);
    expect(quote.dueInterestMinor).toBe(0);
    const over = await pay(c, loanId, quote.totalMinor + 1);
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('overpayment');

    const done = await pay(c, loanId, quote.totalMinor);
    expect(done.body.status).toBe('POSTED');
    const loan = await loanRow(loanId);
    expect(loan.status).toBe('CLOSED');
    expect(await bal(loan.ledgerAccountId)).toBe(0n);
    expect(loan.schedule.every((r) => r.status === 'PAID' || r.status === 'CLOSED_EARLY')).toBe(true);
    expect(loan.schedule.filter((r) => r.status === 'CLOSED_EARLY').length).toBeGreaterThan(0); // future instalments waived
    const closed = await pay(c, loanId, 1000);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('loan_closed');
    expect((await ctx.http.get('/api/v1/loans').set(bearer(c.token))).body.totalOutstandingMinor).toBe(0);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.some((x: { title: string }) => x.title === 'Loan fully repaid')).toBe(true);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('settlement quote adds interest already due and interest accrued this period (computed in integers)', async () => {
    const c = await makePayer(ctx, nm('lacc'), 0n);
    const { loanId } = await disbursedLoan(c, { amountMinor: 30_000_000, termMonths: 6 });
    const loan = await loanRow(loanId);
    const asOf = new Date(loan.schedule[0]!.dueDate.getTime() + 10 * 86_400_000); // 10 days after the first instalment fell due, unpaid
    const q = await loans.settlementQuote(c.id, loanId, asOf);
    expect(q.principalMinor).toBe(30_000_000);
    expect(q.dueInterestMinor).toBe(Number(loan.schedule[0]!.interestMinor));
    const expectedAccrued = (30_000_000n * 1450n * 10n) / (365n * 10_000n);
    expect(q.accruedInterestMinor).toBe(Number(expectedAccrued));
    expect(q.totalMinor).toBe(q.principalMinor + q.dueInterestMinor + q.accruedInterestMinor);
  });

  it('job: unpaid instalments become OVERDUE once, with one notification; upcoming ones get one reminder', async () => {
    const c = await makePayer(ctx, nm('ljob'), 0n);
    const { loanId } = await disbursedLoan(c);
    const loan = await loanRow(loanId);
    await ctx.prisma.loanRepaymentSchedule.update({ where: { id: loan.schedule[0]!.id }, data: { dueDate: new Date(Date.now() - 2 * 86_400_000) } });
    await ctx.prisma.loanRepaymentSchedule.update({ where: { id: loan.schedule[1]!.id }, data: { dueDate: new Date(Date.now() + 2 * 86_400_000) } });
    const r1 = await loans.runDue(new Date());
    expect(r1.overdue).toBeGreaterThanOrEqual(1);
    expect(r1.reminders).toBeGreaterThanOrEqual(1);
    const r2 = await loans.runDue(new Date());
    expect(r2.overdue).toBe(0); // idempotent
    expect(r2.reminders).toBe(0);
    const rows = (await loanRow(loanId)).schedule;
    expect(rows[0]!.status).toBe('OVERDUE');
    expect(rows[1]!.reminderSent).toBe(true);
    await relayOutboxBatch(ctx.prisma as never, 500);
    const titles = (await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.map((x: { title: string }) => x.title);
    expect(titles.filter((t: string) => t === 'Loan instalment overdue')).toHaveLength(1);
    expect(titles.filter((t: string) => t === 'Loan instalment due soon')).toHaveLength(1);
    // paying an overdue instalment clears it
    await ledger.post({ reference: nm('TOPUP'), kind: 'TEST', currency: 'LKR', postings: [
      { ledgerAccountId: await ledger.systemAccountId('cash'), direction: 'DEBIT', amountMinor: 10_000_000n, currency: 'LKR' },
      { ledgerAccountId: c.ledgerId, direction: 'CREDIT', amountMinor: 10_000_000n, currency: 'LKR' } ] });
    expect((await pay(c, loanId, Number(rows[0]!.principalMinor + rows[0]!.interestMinor))).body.status).toBe('POSTED');
    expect((await loanRow(loanId)).schedule[0]!.status).toBe('PAID');
  });

  it('a loan payment that would not fit (insufficient funds) FAILS without touching the loan', async () => {
    const c = await makePayer(ctx, nm('lnsf'), 0n);
    const { loanId } = await disbursedLoan(c, { amountMinor: 10_000_000, termMonths: 6 });
    // drain the disbursed money so the instalment cannot be paid
    const peer = await makePayer(ctx, nm('lnsfb'), 0n);
    await ledger.post({ reference: nm('DRAINL'), kind: 'TEST', currency: 'LKR', postings: [
      { ledgerAccountId: c.ledgerId, direction: 'DEBIT', amountMinor: 10_000_000n, currency: 'LKR' },
      { ledgerAccountId: peer.ledgerId, direction: 'CREDIT', amountMinor: 10_000_000n, currency: 'LKR' } ] });
    const r = await pay(c, loanId, 500_000);
    expect(r.status).toBe(422); // refused up-front by the balance check
    const loan = await loanRow(loanId);
    expect(loan.schedule.every((x) => x.paidPrincipalMinor === 0n && x.paidInterestMinor === 0n)).toBe(true);
    expect(await ctx.prisma.loanPayment.count({ where: { loanId } })).toBe(0);
  });

  it('ledger reconciles after the whole loan lifecycle', async () => {
    const r = await ledger.reconcile();
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
