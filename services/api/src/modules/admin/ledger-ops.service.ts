import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';

const KINDS = ['PAYMENT_REVERSAL', 'LEDGER_ADJUSTMENT'] as const;
const DEFAULT_MAX_ADJUSTMENT = 10_000_000; // LKR 100,000; override "adjustments.maxMinor"

/**
 * Controlled corrections to the ledger. Nothing here edits history: a reversal posts an equal-and-opposite journal and an
 * adjustment posts a new journal against a system account. Both are two-person: one staff member requests, a DIFFERENT
 * one approves (enforced in code AND by a database CHECK on ApprovalRequest).
 */
@Injectable()
export class LedgerOpsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  async requestReversal(staffId: string, paymentId: string, reason: string) {
    const p = await this.prisma.paymentInstruction.findUnique({ where: { id: paymentId } });
    if (!p) throw new NotFoundException({ code: 'not_found', message: 'Payment not found' });
    if (p.status !== 'POSTED') throw new ConflictException({ code: 'not_reversible', message: 'Only a posted payment can be reversed' });
    if (p.kind === 'LOAN_INSTALMENT') throw new ConflictException({ code: 'not_reversible_kind', message: 'Loan repayments cannot be reversed here: they also change the repayment schedule' });
    if (await this.prisma.approvalRequest.count({ where: { kind: 'PAYMENT_REVERSAL', subjectId: paymentId, status: 'PENDING' } })) throw new ConflictException({ code: 'request_in_progress', message: 'A reversal is already waiting for approval' });
    const a = await this.prisma.approvalRequest.create({ data: { kind: 'PAYMENT_REVERSAL', subjectType: 'PaymentInstruction', subjectId: paymentId, requestedBy: staffId, payload: { reason, reference: p.reference, amountMinor: p.amountMinor.toString() } } });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'ledger.reversal_requested', subjectType: 'PaymentInstruction', subjectId: paymentId, reasonCode: reason.slice(0, 100) });
    return { approvalId: a.id, status: a.status };
  }

  async requestAdjustment(staffId: string, i: { accountId: string; direction: 'CREDIT' | 'DEBIT'; amountMinor: number; reason: string }) {
    const cfg = await this.prisma.systemConfiguration.findUnique({ where: { key: 'adjustments.maxMinor' } });
    const max = typeof cfg?.value === 'number' ? cfg.value : DEFAULT_MAX_ADJUSTMENT;
    if (i.amountMinor > max) throw new UnprocessableEntityException({ code: 'limit_exceeded', message: `A single adjustment cannot exceed ${lkr(max)}`, fields: { amountMinor: 'Above the adjustment limit' } });
    const acc = await this.prisma.account.findUnique({ where: { id: i.accountId } });
    if (!acc || acc.status === 'CLOSED') throw new NotFoundException({ code: 'not_found', message: 'Account not found or closed' });
    const a = await this.prisma.approvalRequest.create({ data: { kind: 'LEDGER_ADJUSTMENT', subjectType: 'Account', subjectId: i.accountId, requestedBy: staffId, payload: { direction: i.direction, amountMinor: String(i.amountMinor), reason: i.reason } } });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'ledger.adjustment_requested', subjectType: 'Account', subjectId: i.accountId, reasonCode: i.reason.slice(0, 100), metadata: { direction: i.direction, amountMinor: i.amountMinor } });
    return { approvalId: a.id, status: a.status };
  }

  async list(status: string) {
    const s = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status) ? status : 'PENDING';
    const rows = await this.prisma.approvalRequest.findMany({ where: { kind: { in: [...KINDS] }, status: s as 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 100 });
    const staff = new Map((await this.prisma.staffProfile.findMany({ where: { userId: { in: [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy].filter((x): x is string => !!x)))] } } })).map((p) => [p.userId, p.fullName]));
    return {
      items: rows.map((r) => {
        const p = r.payload as Record<string, string>;
        return { id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt, requestedBy: r.requestedBy, requestedByName: staff.get(r.requestedBy), decidedByName: r.decidedBy ? staff.get(r.decidedBy) : null, subjectId: r.subjectId, reason: p.reason, reference: p.reference ?? null, direction: p.direction ?? null, amountMinor: p.amountMinor ? Number(p.amountMinor) : null, decisionReason: r.reason };
      }),
    };
  }

  async decide(checkerId: string, approvalId: string, d: { decision: 'APPROVE' | 'REJECT'; reason?: string }) {
    if (d.decision === 'REJECT' && !d.reason) throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { reason: 'Required' } });
    const pre = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!pre || !(KINDS as readonly string[]).includes(pre.kind)) throw new NotFoundException({ code: 'not_found', message: 'Approval request not found' });
    if (pre.requestedBy === checkerId) {
      await this.audit.securityEvent('MAKER_CHECKER_VIOLATION', checkerId, { approvalId, kind: pre.kind }, 'HIGH');
      throw new ForbiddenException({ code: 'maker_checker', message: 'A different staff member must approve this request' });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.approvalRequest.updateMany({ where: { id: approvalId, status: 'PENDING' }, data: { status: d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedBy: checkerId, decidedAt: new Date(), reason: d.reason ?? null } });
        if (claimed.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This request was already decided' });
        if (d.decision === 'REJECT') {
          await this.audit.record({ actorId: checkerId, actorType: 'STAFF', action: 'ledger.request_rejected', subjectType: pre.subjectType, subjectId: pre.subjectId, reasonCode: d.reason?.slice(0, 100), metadata: { kind: pre.kind } }, tx);
          return { approvalId, status: 'REJECTED' as const };
        }
        const payload = pre.payload as Record<string, string>;
        if (pre.kind === 'PAYMENT_REVERSAL') await this.executeReversal(tx, checkerId, pre.requestedBy, pre.subjectId, approvalId, payload.reason ?? '');
        else await this.executeAdjustment(tx, checkerId, pre.requestedBy, pre.subjectId, approvalId, payload);
        return { approvalId, status: 'APPROVED' as const };
      }, { maxWait: 10_000, timeout: 20_000 });
    } catch (e) {
      // The whole transaction (including the claim) rolled back: the request stays PENDING so it can be rejected or retried.
      if (e instanceof LedgerRejection) throw new ConflictException({ code: e.code.toLowerCase(), message: e.code === 'INSUFFICIENT_FUNDS' ? 'The ledger cannot apply this: an account does not have enough funds. The request stays pending.' : e.message });
      throw e;
    }
  }

  private async executeReversal(tx: Prisma.TransactionClient, checkerId: string, makerId: string, paymentId: string, approvalId: string, reason: string) {
    await tx.$queryRaw`SELECT id FROM "PaymentInstruction" WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const p = await tx.paymentInstruction.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.status !== 'POSTED') throw new ConflictException({ code: 'not_reversible', message: 'The payment is no longer in a reversible state' });
    const journal = await tx.ledgerJournal.findUnique({ where: { paymentId } });
    if (!journal) throw new ConflictException({ code: 'not_reversible', message: 'No ledger journal exists for this payment' });
    await this.ledger.reverse(journal.id, `REV-${p.reference}`, `Reversal of ${p.reference}: ${reason.slice(0, 80)}`, tx);
    await tx.paymentInstruction.update({ where: { id: paymentId }, data: { status: 'REVERSED' } });
    const dest = p.destination as { toCustomerId?: string; name?: string };
    const notify = [{ userId: p.initiatorId, category: 'TRANSACTION' as const, title: 'Payment reversed', body: `${lkr(p.amountMinor + p.feeMinor)} was returned to your account. Ref ${p.reference}` }];
    if (dest.toCustomerId && dest.toCustomerId !== p.initiatorId) notify.push({ userId: dest.toCustomerId, category: 'TRANSACTION', title: 'Payment reversed', body: `A payment of ${lkr(p.amountMinor)} (ref ${p.reference}) was reversed by the bank.` });
    await queueNotifications(tx, 'payment.reversed', notify);
    await this.audit.record({ actorId: checkerId, actorType: 'STAFF', action: 'ledger.reversal_approved', subjectType: 'PaymentInstruction', subjectId: paymentId, reasonCode: reason.slice(0, 100), metadata: { makerId, approvalId } }, tx);
  }

  private async executeAdjustment(tx: Prisma.TransactionClient, checkerId: string, makerId: string, accountId: string, approvalId: string, p: Record<string, string>) {
    const la = await tx.ledgerAccount.findUnique({ where: { accountId } });
    if (!la) throw new ConflictException({ code: 'not_found', message: 'The account has no ledger account' });
    const amount = BigInt(p.amountMinor!);
    const sys = await this.ledger.systemAccountId('adjustments', tx);
    // Customer accounts are liabilities: crediting increases the customer's balance, debiting decreases it.
    const [dr, cr] = p.direction === 'CREDIT' ? [sys, la.id] : [la.id, sys];
    await this.ledger.post({ reference: `ADJ-${approvalId}`, kind: 'ADJUSTMENT', currency: la.currency, description: `Bank adjustment: ${(p.reason ?? '').slice(0, 80)}`, postings: [
      { ledgerAccountId: dr, direction: 'DEBIT', amountMinor: amount, currency: la.currency },
      { ledgerAccountId: cr, direction: 'CREDIT', amountMinor: amount, currency: la.currency } ] }, tx);
    const acc = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
    await queueNotifications(tx, 'ledger.adjusted', [{ userId: acc.customerId, category: 'TRANSACTION', title: 'Account adjusted', body: `The bank ${p.direction === 'CREDIT' ? 'credited' : 'debited'} ${lkr(amount)} ${p.direction === 'CREDIT' ? 'to' : 'from'} your account.` }]);
    await this.audit.record({ actorId: checkerId, actorType: 'STAFF', action: 'ledger.adjustment_approved', subjectType: 'Account', subjectId: accountId, reasonCode: (p.reason ?? '').slice(0, 100), metadata: { makerId, approvalId, direction: p.direction, amountMinor: p.amountMinor ?? '' } }, tx);
  }

  /** Read-only helper for the reconciliation page. */
  async reconciliation() {
    const r = await this.ledger.reconcile();
    const pending = await this.prisma.approvalRequest.count({ where: { kind: { in: [...KINDS] }, status: 'PENDING' } });
    return { ...r, pendingApprovals: pending, totalAdjustmentsMinor: num((await this.prisma.ledgerAccount.findUnique({ where: { code: 'SYS-ADJUSTMENT-LKR' } }))?.balanceMinor ?? 0n) };
  }
}
