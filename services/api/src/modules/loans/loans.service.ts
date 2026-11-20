import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type Loan, type LoanRepaymentSchedule } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { lkr, queueNotifications } from '../../common/notify';
import { PaymentRefusal } from '../../common/refusal';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';
import { affordability, buildSchedule, emi, totalInterest } from './amortization';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () => `LN${Array.from({ length: 9 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
const DAY = 86_400_000;
const MAX_PENDING_APPLICATIONS = 3;

/** Sample loan products (fictional). Staff-managed product configuration arrives with the settings phase. */
export const DEFAULT_LOAN_PRODUCTS = [
  { code: 'PERSONAL', name: 'Personal Loan', minAmountMinor: 5_000_000n, maxAmountMinor: 500_000_000n, minTermMonths: 6, maxTermMonths: 60, rateBps: 1450 },
  { code: 'EDUCATION', name: 'Education Loan', minAmountMinor: 10_000_000n, maxAmountMinor: 1_000_000_000n, minTermMonths: 12, maxTermMonths: 84, rateBps: 1100 },
  { code: 'VEHICLE', name: 'Vehicle Loan', minAmountMinor: 50_000_000n, maxAmountMinor: 3_000_000_000n, minTermMonths: 12, maxTermMonths: 84, rateBps: 1250 },
  { code: 'HOME', name: 'Home Loan', minAmountMinor: 100_000_000n, maxAmountMinor: 20_000_000_000n, minTermMonths: 60, maxTermMonths: 300, rateBps: 1050 },
];

export interface RepaymentPlan {
  loanId: string;
  principalMinor: bigint;
  interestMinor: bigint;
  settle: boolean;
  /** schedule row id -> new paid amounts / status */
  updates: { id: string; paidPrincipalMinor: bigint; paidInterestMinor: bigint; status: string }[];
  loanLedgerAccountId: string;
  reference: string;
}

const APP_STATUS_TEXT: Record<string, string> = {
  SUBMITTED: 'Received', UNDER_REVIEW: 'Under review', APPROVED: 'Approved', REJECTED: 'Not approved', DISBURSED: 'Funds paid out', CANCELLED: 'Cancelled',
};

type ScheduleRow = LoanRepaymentSchedule;

@Injectable()
export class LoansService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  // ───────────────────────── products & calculator ─────────────────────────
  async products() {
    const rows = await this.prisma.loanProduct.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
    return { items: rows.map((p) => ({ code: p.code, name: p.name, minAmountMinor: num(p.minAmountMinor), maxAmountMinor: num(p.maxAmountMinor), minTermMonths: p.minTermMonths, maxTermMonths: p.maxTermMonths, rateBps: p.rateBps })) };
  }

  private async product(code: string) {
    const p = await this.prisma.loanProduct.findFirst({ where: { code, active: true } });
    if (!p) throw new NotFoundException({ code: 'product_not_found', message: 'That loan type is not available' });
    return p;
  }

  private checkRanges(p: { minAmountMinor: bigint; maxAmountMinor: bigint; minTermMonths: number; maxTermMonths: number }, amount: bigint, term: number) {
    if (amount < p.minAmountMinor || amount > p.maxAmountMinor) throw new UnprocessableEntityException({ code: 'amount_out_of_range', message: `Choose an amount between ${lkr(p.minAmountMinor)} and ${lkr(p.maxAmountMinor)}`, fields: { amountMinor: 'Out of range' } });
    if (term < p.minTermMonths || term > p.maxTermMonths) throw new UnprocessableEntityException({ code: 'term_out_of_range', message: `Choose a term between ${p.minTermMonths} and ${p.maxTermMonths} months`, fields: { termMonths: 'Out of range' } });
  }

  /** INFORMATIONAL. An estimate of the instalment and affordability - not a decision and not an offer. */
  async calculate(code: string, amountMinor: number, termMonths: number, monthlyIncomeMinor?: number) {
    const p = await this.product(code);
    this.checkRanges(p, BigInt(amountMinor), termMonths);
    const sched = buildSchedule(BigInt(amountMinor), p.rateBps, termMonths, new Date());
    const e = emi(BigInt(amountMinor), p.rateBps, termMonths);
    return {
      productCode: code, rateBps: p.rateBps, termMonths, emiMinor: num(e), totalInterestMinor: num(totalInterest(sched)), totalPayableMinor: num(BigInt(amountMinor) + totalInterest(sched)),
      ...(monthlyIncomeMinor ? { eligibility: { ...affordability(e, BigInt(monthlyIncomeMinor)), disclaimer: 'This is an estimate to help you plan. It is not an approval and the bank may decide differently.' } } : {}),
    };
  }

  // ───────────────────────── applications ─────────────────────────
  async apply(customerId: string, i: { productCode: string; amountMinor: number; termMonths: number; monthlyIncomeMinor: number; employment: string; purpose?: string; disbursementAccountId: string; consent: true }) {
    const p = await this.product(i.productCode);
    this.checkRanges(p, BigInt(i.amountMinor), i.termMonths);
    const acc = await this.prisma.account.findUnique({ where: { id: i.disbursementAccountId } });
    if (!acc || acc.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    if (acc.status !== 'ACTIVE') throw new ConflictException({ code: 'account_restricted', message: 'The account for the funds must be active' });
    const pending = await this.prisma.loanApplication.count({ where: { customerId, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } });
    if (pending >= MAX_PENDING_APPLICATIONS) throw new ConflictException({ code: 'too_many_applications', message: 'You already have applications under review' });
    const e = emi(BigInt(i.amountMinor), p.rateBps, i.termMonths);
    const assessment = { emiMinor: e.toString(), ...affordability(e, BigInt(i.monthlyIncomeMinor)) };
    const app = await this.prisma.loanApplication.create({
      data: { customerId, productId: p.id, amountMinor: BigInt(i.amountMinor), termMonths: i.termMonths, monthlyIncomeMinor: BigInt(i.monthlyIncomeMinor), employment: i.employment, purpose: i.purpose, disbursementAccountId: acc.id, assessment },
    });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'loan.application_submitted', subjectType: 'LoanApplication', subjectId: app.id });
    return { id: app.id, status: app.status, statusText: APP_STATUS_TEXT[app.status] };
  }

  async myApplications(customerId: string) {
    const rows = await this.prisma.loanApplication.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const products = new Map((await this.prisma.loanProduct.findMany()).map((p) => [p.id, p]));
    return {
      items: rows.map((a) => ({
        id: a.id, productName: products.get(a.productId)?.name, amountMinor: num(a.amountMinor), termMonths: a.termMonths, status: a.status, statusText: APP_STATUS_TEXT[a.status], createdAt: a.createdAt,
        decisionReason: a.status === 'REJECTED' ? a.decisionReason : null, loanId: a.loanId,
        // customer-facing progress tracker; no internal notes
        steps: [
          { label: 'Application received', done: true },
          { label: 'Under review', done: a.status !== 'SUBMITTED' },
          { label: a.status === 'REJECTED' ? 'Not approved' : 'Approved by the bank', done: ['APPROVED', 'DISBURSED', 'REJECTED'].includes(a.status) },
          { label: 'Funds paid out', done: a.status === 'DISBURSED' },
        ],
      })),
    };
  }

  // ───────────────────────── loans (customer) ─────────────────────────
  private async outstanding(ledgerAccountId: string): Promise<bigint> {
    return (await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: ledgerAccountId } })).balanceMinor;
  }

  private loanView(l: Loan, product: string | undefined, outstanding: bigint, rows: ScheduleRow[]) {
    const next = rows.find((r) => r.status !== 'PAID' && r.status !== 'CLOSED_EARLY');
    return {
      id: l.id, reference: l.reference, productName: product, principalMinor: num(l.principalMinor), outstandingPrincipalMinor: num(outstanding), rateBps: l.rateBps, termMonths: l.termMonths, status: l.status, startDate: l.startDate.toISOString(),
      next: next ? { instalmentNo: next.instalmentNo, dueDate: next.dueDate.toISOString(), dueMinor: num(next.principalMinor + next.interestMinor - next.paidPrincipalMinor - next.paidInterestMinor), status: next.status } : null,
    };
  }

  async listLoans(customerId: string) {
    const loans = await this.prisma.loan.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, include: { schedule: { orderBy: { instalmentNo: 'asc' } } } });
    const products = new Map((await this.prisma.loanProduct.findMany()).map((p) => [p.id, p.name]));
    const items = await Promise.all(loans.map(async (l) => this.loanView(l, products.get(l.productId), await this.outstanding(l.ledgerAccountId), l.schedule)));
    return { items, totalOutstandingMinor: items.filter((i) => i.status === 'ACTIVE').reduce((s, i) => s + i.outstandingPrincipalMinor, 0) };
  }

  private async ownedLoan(customerId: string, id: string) {
    const l = await this.prisma.loan.findUnique({ where: { id }, include: { schedule: { orderBy: { instalmentNo: 'asc' } } } });
    if (!l || l.customerId !== customerId) {
      if (l) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Loan', id });
      throw new NotFoundException({ code: 'not_found', message: 'Loan not found' });
    }
    return l;
  }

  async loanDetail(customerId: string, id: string) {
    const l = await this.ownedLoan(customerId, id);
    const [product, payments] = await Promise.all([this.prisma.loanProduct.findUnique({ where: { id: l.productId } }), this.prisma.loanPayment.findMany({ where: { loanId: id }, orderBy: { createdAt: 'desc' }, take: 50 })]);
    const outstanding = await this.outstanding(l.ledgerAccountId);
    return {
      ...this.loanView(l, product?.name, outstanding, l.schedule),
      schedule: l.schedule.map((r) => ({ no: r.instalmentNo, dueDate: r.dueDate.toISOString(), principalMinor: num(r.principalMinor), interestMinor: num(r.interestMinor), paidMinor: num(r.paidPrincipalMinor + r.paidInterestMinor), status: r.status })),
      payments: payments.map((p) => ({ at: p.createdAt, amountMinor: num(p.amountMinor), principalMinor: num(p.principalMinor), interestMinor: num(p.interestMinor) })),
    };
  }

  /** What it costs to close the loan today: outstanding principal + interest already due + interest accrued this period. */
  async settlementQuote(customerId: string, id: string, now = new Date()) {
    const l = await this.ownedLoan(customerId, id);
    return { ...(await this.computeSettlement(l, l.schedule, now)), asOf: now.toISOString() };
  }

  private computeSettlement(l: Loan, rows: ScheduleRow[], now: Date): { principalMinor: number; dueInterestMinor: number; accruedInterestMinor: number; totalMinor: number } {
    const open = rows.filter((r) => r.status !== 'PAID' && r.status !== 'CLOSED_EARLY');
    const principal = open.reduce((s, r) => s + r.principalMinor - r.paidPrincipalMinor, 0n);
    const dueInterest = open.filter((r) => r.dueDate <= now).reduce((s, r) => s + r.interestMinor - r.paidInterestMinor, 0n);
    const upcoming = open.find((r) => r.dueDate > now);
    let accrued = 0n;
    if (upcoming) {
      const prev = [...rows].reverse().find((r) => r.dueDate <= now);
      const periodStart = prev ? prev.dueDate : l.startDate;
      const days = BigInt(Math.max(0, Math.floor((now.getTime() - periodStart.getTime()) / DAY)));
      accrued = (principal * BigInt(l.rateBps) * days) / (365n * 10_000n);
      const room = upcoming.interestMinor - upcoming.paidInterestMinor;
      if (accrued > room) accrued = room;
      if (accrued < 0n) accrued = 0n;
    }
    return { principalMinor: num(principal), dueInterestMinor: num(dueInterest), accruedInterestMinor: num(accrued), totalMinor: num(principal + dueInterest + accrued) };
  }

  // ───────────────────────── repayment (called inside the payment transaction) ─────────────────────────
  /** Resolves a loan payment destination for the payment pipeline (ownership + state). */
  async resolveForPayment(customerId: string, loanId: string) {
    const l = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!l || l.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Loan not found' });
    if (l.status !== 'ACTIVE') throw new ConflictException({ code: 'loan_closed', message: 'This loan is already settled' });
    const product = await this.prisma.loanProduct.findUnique({ where: { id: l.productId } });
    const settlement = await this.settlementQuote(customerId, loanId);
    return { loan: l, productName: product?.name ?? 'Loan', settlementMinor: BigInt(settlement.totalMinor) };
  }

  /**
   * Decides how a payment is applied, under a lock on the loan, WITHOUT writing. Interest first, then principal,
   * oldest instalment first (V1 rule). Paying exactly the settlement figure closes the loan and waives future interest.
   * More than the settlement figure is refused. Throws PaymentRefusal (=> the payment FAILS, nothing is posted).
   */
  async planRepayment(tx: Prisma.TransactionClient, loanId: string, amount: bigint, reference: string, now: Date): Promise<RepaymentPlan> {
    await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId}::uuid FOR UPDATE`;
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId }, include: { schedule: { orderBy: { instalmentNo: 'asc' } } } });
    if (loan.status !== 'ACTIVE') throw new PaymentRefusal('LOAN_CLOSED');
    const rows = loan.schedule.filter((r) => r.status !== 'PAID' && r.status !== 'CLOSED_EARLY');
    const settlement = BigInt(this.computeSettlement(loan, loan.schedule, now).totalMinor);
    if (amount > settlement) throw new PaymentRefusal('OVERPAYMENT');

    const updates: RepaymentPlan['updates'] = [];
    let principalPaid = 0n, interestPaid = 0n;
    if (amount === settlement) {
      // Early settlement: pay all outstanding principal; everything else is interest due/accrued; future rows are waived.
      const principal = rows.reduce((s, r) => s + r.principalMinor - r.paidPrincipalMinor, 0n);
      principalPaid = principal;
      interestPaid = amount - principal;
      for (const r of rows) updates.push({ id: r.id, paidPrincipalMinor: r.principalMinor, paidInterestMinor: r.dueDate <= now ? r.interestMinor : r.paidInterestMinor, status: r.dueDate <= now ? 'PAID' : 'CLOSED_EARLY' });
    } else {
      let left = amount;
      for (const r of rows) {
        if (left <= 0n) break;
        const intDue = r.interestMinor - r.paidInterestMinor;
        const payInt = left < intDue ? left : intDue;
        left -= payInt;
        const prinDue = r.principalMinor - r.paidPrincipalMinor;
        const payPrin = left < prinDue ? left : prinDue;
        left -= payPrin;
        interestPaid += payInt;
        principalPaid += payPrin;
        const fullyPaid = payInt === intDue && payPrin === prinDue;
        updates.push({ id: r.id, paidPrincipalMinor: r.paidPrincipalMinor + payPrin, paidInterestMinor: r.paidInterestMinor + payInt, status: fullyPaid ? 'PAID' : 'PARTIAL' });
      }
    }
    return { loanId, principalMinor: principalPaid, interestMinor: interestPaid, settle: amount === settlement, updates, loanLedgerAccountId: loan.ledgerAccountId, reference };
  }

  /** Persists a plan (after the ledger journal succeeded, inside the same transaction). */
  async commitRepayment(tx: Prisma.TransactionClient, plan: RepaymentPlan, paymentId: string, amount: bigint): Promise<void> {
    for (const u of plan.updates) await tx.loanRepaymentSchedule.update({ where: { id: u.id }, data: { paidPrincipalMinor: u.paidPrincipalMinor, paidInterestMinor: u.paidInterestMinor, status: u.status } });
    await tx.loanPayment.create({ data: { loanId: plan.loanId, paymentId, amountMinor: amount, principalMinor: plan.principalMinor, interestMinor: plan.interestMinor } });
    const remaining = await tx.loanRepaymentSchedule.count({ where: { loanId: plan.loanId, status: { notIn: ['PAID', 'CLOSED_EARLY'] } } });
    if (remaining === 0) {
      await tx.loan.update({ where: { id: plan.loanId }, data: { status: 'CLOSED', closedAt: new Date() } });
      const l = await tx.loan.findUniqueOrThrow({ where: { id: plan.loanId } });
      await queueNotifications(tx, 'loan.closed', [{ userId: l.customerId, category: 'LOAN', title: 'Loan fully repaid', body: `Loan ${l.reference} is now settled. Thank you.` }]);
    }
  }

  // ───────────────────────── staff: review, recommend, approve (maker-checker) ─────────────────────────
  async queue(status: string) {
    const s = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DISBURSED'].includes(status) ? status : 'SUBMITTED';
    const rows = await this.prisma.loanApplication.findMany({ where: { status: s }, orderBy: { createdAt: 'asc' }, take: 100 });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    const products = new Map((await this.prisma.loanProduct.findMany()).map((p) => [p.id, p]));
    return {
      items: rows.map((a) => ({
        id: a.id, status: a.status, createdAt: a.createdAt, productName: products.get(a.productId)?.name, rateBps: products.get(a.productId)?.rateBps, amountMinor: num(a.amountMinor), termMonths: a.termMonths,
        monthlyIncomeMinor: num(a.monthlyIncomeMinor), employment: a.employment, purpose: a.purpose, assessment: a.assessment, customerName: customers.get(a.customerId)?.fullName, customerNumber: customers.get(a.customerId)?.customerNumber,
        kycStatus: customers.get(a.customerId)?.kycStatus, approvalRequestId: a.approvalRequestId,
      })),
    };
  }

  /** Step 1 (maker): a loan officer recommends specific terms. This only CREATES an approval request; no money moves. */
  async recommend(staffId: string, applicationId: string, t: { approvedAmountMinor?: number; termMonths?: number; rateBps?: number; conditions?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const app = await tx.loanApplication.findUnique({ where: { id: applicationId } });
      if (!app) throw new NotFoundException({ code: 'not_found', message: 'Application not found' });
      if (!['SUBMITTED', 'UNDER_REVIEW'].includes(app.status) || app.approvalRequestId) throw new ConflictException({ code: 'not_reviewable', message: 'This application is not awaiting a recommendation' });
      const p = await tx.loanProduct.findUniqueOrThrow({ where: { id: app.productId } });
      const amount = BigInt(t.approvedAmountMinor ?? Number(app.amountMinor));
      const term = t.termMonths ?? app.termMonths;
      const rate = t.rateBps ?? p.rateBps;
      if (amount > app.amountMinor) throw new BadRequestException({ code: 'validation_failed', message: 'Approved amount cannot exceed the amount requested', fields: { approvedAmountMinor: 'Too high' } });
      this.checkRanges(p, amount, term);
      const cust = await tx.customerProfile.findUniqueOrThrow({ where: { userId: app.customerId }, include: { user: true } });
      if (cust.kycStatus !== 'APPROVED' || cust.user.status !== 'ACTIVE') throw new ConflictException({ code: 'customer_not_verified', message: 'The customer is not verified' });
      const approval = await tx.approvalRequest.create({
        data: { kind: 'LOAN_DISBURSEMENT', subjectType: 'LoanApplication', subjectId: applicationId, requestedBy: staffId, payload: { amountMinor: amount.toString(), termMonths: term, rateBps: rate, conditions: t.conditions ?? null } },
      });
      await tx.loanApplication.update({ where: { id: applicationId }, data: { status: 'UNDER_REVIEW', approvalRequestId: approval.id } });
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'loan.recommended', subjectType: 'LoanApplication', subjectId: applicationId, metadata: { approvalId: approval.id } }, tx);
      return { applicationId, approvalRequestId: approval.id, status: 'UNDER_REVIEW' as const };
    });
  }

  async rejectApplication(staffId: string, applicationId: string, reason: string) {
    const r = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.loanApplication.updateMany({ where: { id: applicationId, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } }, data: { status: 'REJECTED', decidedById: staffId, decidedAt: new Date(), decisionReason: reason } });
      if (claimed.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This application can no longer be rejected' });
      const app = await tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
      if (app.approvalRequestId) await tx.approvalRequest.updateMany({ where: { id: app.approvalRequestId, status: 'PENDING' }, data: { status: 'CANCELLED', reason: 'Application rejected' } });
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'loan.rejected', subjectType: 'LoanApplication', subjectId: applicationId, reasonCode: reason.slice(0, 100) }, tx);
      await queueNotifications(tx, 'loan.decided', [{ userId: app.customerId, category: 'LOAN', title: 'Loan application not approved', body: reason }]);
      return { applicationId, status: 'REJECTED' as const };
    });
    return r;
  }

  async approvals(status: string) {
    const s = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status) ? status : 'PENDING';
    const rows = await this.prisma.approvalRequest.findMany({ where: { kind: 'LOAN_DISBURSEMENT', status: s as 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 100 });
    const apps = new Map((await this.prisma.loanApplication.findMany({ where: { id: { in: rows.map((r) => r.subjectId) } } })).map((a) => [a.id, a]));
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...apps.values()].map((a) => a.customerId) } } })).map((c) => [c.userId, c]));
    const staff = new Map((await this.prisma.staffProfile.findMany({ where: { userId: { in: rows.map((r) => r.requestedBy) } } })).map((p) => [p.userId, p.fullName]));
    return { items: rows.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt, requestedBy: r.requestedBy, requestedByName: staff.get(r.requestedBy), terms: r.payload, applicationId: r.subjectId, customerName: customers.get(apps.get(r.subjectId)?.customerId ?? '')?.fullName })) };
  }

  /**
   * Step 2 (checker): a DIFFERENT staff member approves or rejects. Approval disburses atomically: loan, schedule,
   * loan ledger account and the disbursement journal all commit together.
   */
  async decideApproval(checkerId: string, approvalId: string, d: { decision: 'APPROVE' | 'REJECT'; reason?: string }) {
    if (d.decision === 'REJECT' && !d.reason) throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { reason: 'Required' } });
    const pre = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!pre || pre.kind !== 'LOAN_DISBURSEMENT') throw new NotFoundException({ code: 'not_found', message: 'Approval request not found' });
    if (pre.requestedBy === checkerId) {
      // Maker-checker: you can never approve your own submission. (The database enforces the same rule with a CHECK.)
      await this.audit.securityEvent('MAKER_CHECKER_VIOLATION', checkerId, { approvalId }, 'HIGH');
      throw new ForbiddenException({ code: 'maker_checker', message: 'A different staff member must approve this request' });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.approvalRequest.updateMany({ where: { id: approvalId, status: 'PENDING' }, data: { status: d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedBy: checkerId, decidedAt: new Date(), reason: d.reason ?? null } });
        if (claimed.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This request was already decided' });
        const app = await tx.loanApplication.findUniqueOrThrow({ where: { id: pre.subjectId } });
        if (d.decision === 'REJECT') {
          await tx.loanApplication.update({ where: { id: app.id }, data: { status: 'REJECTED', decidedById: checkerId, decidedAt: new Date(), decisionReason: d.reason } });
          await this.audit.record({ actorId: checkerId, actorType: 'STAFF', action: 'loan.approval_rejected', subjectType: 'LoanApplication', subjectId: app.id, reasonCode: d.reason?.slice(0, 100) }, tx);
          await queueNotifications(tx, 'loan.decided', [{ userId: app.customerId, category: 'LOAN', title: 'Loan application not approved', body: d.reason! }]);
          return { approvalId, status: 'REJECTED' as const };
        }
        const t = pre.payload as { amountMinor: string; termMonths: number; rateBps: number };
        const amount = BigInt(t.amountMinor);
        const dest = await tx.ledgerAccount.findUnique({ where: { accountId: app.disbursementAccountId } });
        const destAcc = await tx.account.findUniqueOrThrow({ where: { id: app.disbursementAccountId } });
        if (!dest || destAcc.status === 'CLOSED') throw new ConflictException({ code: 'account_restricted', message: 'The disbursement account is not available' });
        const reference = newRef();
        const start = new Date();
        const sched = buildSchedule(amount, t.rateBps, t.termMonths, start);
        const loanLedger = await tx.ledgerAccount.create({ data: { code: `LOAN-${reference}`, name: `Loan ${reference}`, type: 'ASSET', currency: dest.currency } });
        const loan = await tx.loan.create({
          data: { reference, applicationId: app.id, customerId: app.customerId, productId: app.productId, principalMinor: amount, rateBps: t.rateBps, termMonths: t.termMonths, disbursementAccountId: app.disbursementAccountId, ledgerAccountId: loanLedger.id, startDate: start,
            schedule: { create: sched.map((r) => ({ instalmentNo: r.no, dueDate: r.dueDate, principalMinor: r.principalMinor, interestMinor: r.interestMinor })) } },
        });
        // The bank lends: loan receivable (asset) up, customer deposit (liability) up. Balanced by construction.
        await this.ledger.post({ reference: `LOANDISB-${reference}`, kind: 'LOAN_DISBURSEMENT', currency: dest.currency, description: `Loan ${reference} disbursed`, postings: [
          { ledgerAccountId: loanLedger.id, direction: 'DEBIT', amountMinor: amount, currency: dest.currency },
          { ledgerAccountId: dest.id, direction: 'CREDIT', amountMinor: amount, currency: dest.currency } ] }, tx);
        await tx.loanApplication.update({ where: { id: app.id }, data: { status: 'DISBURSED', decidedById: checkerId, decidedAt: new Date(), loanId: loan.id } });
        await this.audit.record({ actorId: checkerId, actorType: 'STAFF', action: 'loan.disbursed', subjectType: 'Loan', subjectId: loan.id, metadata: { makerId: pre.requestedBy, approvalId, reference } }, tx);
        await queueNotifications(tx, 'loan.disbursed', [{ userId: app.customerId, category: 'LOAN', title: 'Loan approved and paid out', body: `${lkr(amount)} was paid into your account. Your first instalment is due ${sched[0]!.dueDate.toISOString().slice(0, 10)}. Ref ${reference}` }]);
        return { approvalId, status: 'APPROVED' as const, loanId: loan.id, reference };
      }, { maxWait: 10_000, timeout: 20_000 });
    } catch (e) {
      if (e instanceof LedgerRejection) throw new ConflictException({ code: e.code.toLowerCase(), message: e.message });
      throw e;
    }
  }

  async adminLoans(status?: string) {
    const rows = await this.prisma.loan.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    const items = await Promise.all(rows.map(async (l) => ({ id: l.id, reference: l.reference, status: l.status, principalMinor: num(l.principalMinor), outstandingMinor: num(await this.outstanding(l.ledgerAccountId)), rateBps: l.rateBps, termMonths: l.termMonths, customerName: customers.get(l.customerId)?.fullName, customerNumber: customers.get(l.customerId)?.customerNumber })));
    return { items };
  }

  // ───────────────────────── job: overdue marking + reminders ─────────────────────────
  async runDue(now: Date): Promise<{ overdue: number; reminders: number }> {
    let overdue = 0, reminders = 0;
    const late = await this.prisma.loanRepaymentSchedule.findMany({ where: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: now } }, take: 500, include: { loan: true } });
    for (const r of late) {
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.loanRepaymentSchedule.updateMany({ where: { id: r.id, status: { in: ['DUE', 'PARTIAL'] } }, data: { status: 'OVERDUE' } });
        if (c.count !== 1) return;
        overdue++;
        await queueNotifications(tx, 'loan.overdue', [{ userId: r.loan.customerId, category: 'LOAN', title: 'Loan instalment overdue', body: `Instalment ${r.instalmentNo} of loan ${r.loan.reference} is overdue. Please pay as soon as you can.` }]);
      });
    }
    const soon = await this.prisma.loanRepaymentSchedule.findMany({ where: { status: 'DUE', reminderSent: false, dueDate: { gte: now, lte: new Date(now.getTime() + 3 * DAY) } }, take: 500, include: { loan: true } });
    for (const r of soon) {
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.loanRepaymentSchedule.updateMany({ where: { id: r.id, reminderSent: false }, data: { reminderSent: true } });
        if (c.count !== 1) return;
        reminders++;
        await queueNotifications(tx, 'loan.reminder', [{ userId: r.loan.customerId, category: 'LOAN', title: 'Loan instalment due soon', body: `Instalment ${r.instalmentNo} of ${lkr(r.principalMinor + r.interestMinor)} is due on ${r.dueDate.toISOString().slice(0, 10)}. Ref ${r.loan.reference}` }]);
      });
    }
    return { overdue, reminders };
  }
}
