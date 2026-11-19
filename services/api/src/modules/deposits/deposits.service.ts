import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type FixedDeposit } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { withIdempotency } from '../../common/idempotency';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { PinService } from '../auth/pin.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';
import { addMonths, earlyClosure, simpleInterest, validTerm } from './interest';

const DEFAULT_PENALTY_BPS = 300; // 3 percentage points off the rate on early closure; override "fd.earlyPenaltyBps"
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ref = () => `FD${Array.from({ length: 9 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

export type Renewal = 'WITH_INTEREST' | 'WITHOUT_INTEREST' | 'PAYOUT';

/** Sample rate card (V1 sample figures: 7.5% for 3 months rising to 11% at 6+ years). Staff manage the live card. */
export const DEFAULT_RATES: { termMonths: number; rateBps: number }[] = [
  { termMonths: 3, rateBps: 750 }, { termMonths: 6, rateBps: 800 }, { termMonths: 12, rateBps: 900 },
  { termMonths: 24, rateBps: 950 }, { termMonths: 36, rateBps: 975 }, { termMonths: 48, rateBps: 1000 }, { termMonths: 60, rateBps: 1025 },
  { termMonths: 72, rateBps: 1100 }, { termMonths: 84, rateBps: 1100 }, { termMonths: 96, rateBps: 1100 }, { termMonths: 108, rateBps: 1100 }, { termMonths: 120, rateBps: 1100 },
];

@Injectable()
export class DepositsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService, private readonly pins: PinService) {}

  private async penaltyBps(): Promise<number> {
    const c = await this.prisma.systemConfiguration.findUnique({ where: { key: 'fd.earlyPenaltyBps' } });
    return typeof c?.value === 'number' ? c.value : DEFAULT_PENALTY_BPS;
  }

  async rates() {
    const rows = await this.prisma.fixedDepositRate.findMany({ where: { active: true }, orderBy: { termMonths: 'asc' } });
    return { items: rows.map((r) => ({ termMonths: r.termMonths, rateBps: r.rateBps, minAmountMinor: num(r.minAmountMinor) })) };
  }

  async adminRates() {
    const rows = await this.prisma.fixedDepositRate.findMany({ orderBy: { termMonths: 'asc' } });
    return { items: rows.map((r) => ({ termMonths: r.termMonths, rateBps: r.rateBps, minAmountMinor: num(r.minAmountMinor), active: r.active })) };
  }

  /** Informational projection for the calculator and comparison screens. */
  async calculate(amountMinor: number, termMonths: number) {
    const rate = await this.rateFor(termMonths);
    const interest = simpleInterest(BigInt(amountMinor), rate.rateBps, termMonths);
    return { termMonths, rateBps: rate.rateBps, minAmountMinor: num(rate.minAmountMinor), interestMinor: num(interest), maturityValueMinor: num(BigInt(amountMinor) + interest), maturityDate: addMonths(new Date(), termMonths).toISOString(), note: 'Simple interest for the term. The bank confirms the rate when you open the deposit.' };
  }

  private async rateFor(termMonths: number) {
    if (!validTerm(termMonths)) throw new BadRequestException({ code: 'invalid_term', message: 'Choose 3, 6 or 12 months, or a whole number of years up to 10', fields: { termMonths: 'Invalid term' } });
    const r = await this.prisma.fixedDepositRate.findFirst({ where: { termMonths, active: true } });
    if (!r) throw new NotFoundException({ code: 'rate_unavailable', message: 'That term is not available right now' });
    return r;
  }

  private view(fd: FixedDeposit & { ledgerBalance?: bigint }, pendingClosure = false) {
    const interest = simpleInterest(fd.principalMinor, fd.rateBps, fd.termMonths);
    return {
      id: fd.id, reference: fd.reference, status: fd.status, principalMinor: num(fd.principalMinor), originalPrincipalMinor: num(fd.originalPrincipalMinor), rateBps: fd.rateBps, termMonths: fd.termMonths,
      startDate: fd.startDate.toISOString(), maturityDate: fd.maturityDate.toISOString(), renewal: fd.renewal, renewalCount: fd.renewalCount, fundingAccountId: fd.fundingAccountId,
      interestAtMaturityMinor: num(interest), maturityValueMinor: num(fd.principalMinor + interest), daysLeft: Math.max(0, Math.ceil((fd.maturityDate.getTime() - Date.now()) / 86_400_000)), closureRequested: pendingClosure,
    };
  }

  async list(customerId: string) {
    const rows = await this.prisma.fixedDeposit.findMany({ where: { customerId }, orderBy: { startDate: 'desc' } });
    const pending = new Set((await this.prisma.fixedDepositClosureRequest.findMany({ where: { customerId, status: 'PENDING' }, select: { fixedDepositId: true } })).map((p) => p.fixedDepositId));
    const active = rows.filter((r) => r.status === 'ACTIVE');
    return {
      items: rows.map((r) => this.view(r, pending.has(r.id))),
      lockedMinor: num(active.reduce((s, r) => s + r.principalMinor, 0n)),
      interestToComeMinor: num(active.reduce((s, r) => s + simpleInterest(r.principalMinor, r.rateBps, r.termMonths), 0n)),
    };
  }

  private async owned(customerId: string, id: string) {
    const fd = await this.prisma.fixedDeposit.findUnique({ where: { id } });
    if (!fd || fd.customerId !== customerId) {
      if (fd) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'FixedDeposit', id });
      throw new NotFoundException({ code: 'not_found', message: 'Fixed deposit not found' });
    }
    return fd;
  }

  async detail(customerId: string, id: string) {
    const fd = await this.owned(customerId, id);
    const [renewals, pending] = await Promise.all([
      this.prisma.fixedDepositRenewal.findMany({ where: { fixedDepositId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.fixedDepositClosureRequest.count({ where: { fixedDepositId: id, status: 'PENDING' } }),
    ]);
    return { ...this.view(fd, pending > 0), renewals: renewals.map((r) => ({ at: r.createdAt, interestMinor: num(r.interestMinor), newPrincipalMinor: num(r.newPrincipalMinor), newMaturityDate: r.newMaturityDate })) };
  }

  // ───────────────────────── open ─────────────────────────
  /** Funding is a ledger transfer from the customer's account into the deposit's own ledger account. Needs the PIN and an Idempotency-Key. */
  async open(customerId: string, key: string | undefined, i: { fundingAccountId: string; amountMinor: number; termMonths: number; renewal: Renewal; pin: string }) {
    let rate: Awaited<ReturnType<DepositsService['rateFor']>>;
    const { result, replayed } = await withIdempotency(this.prisma, {
      userId: customerId, scope: 'POST /v1/fixed-deposits', key, body: i,
      precheck: async () => {
        rate = await this.rateFor(i.termMonths);
        if (BigInt(i.amountMinor) < rate.minAmountMinor) throw new UnprocessableEntityException({ code: 'below_minimum', message: `The minimum deposit is ${lkr(rate.minAmountMinor)}`, fields: { amountMinor: 'Below the minimum' } });
        const acc = await this.prisma.account.findUnique({ where: { id: i.fundingAccountId }, include: { product: true } });
        if (!acc || acc.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
        if (acc.status !== 'ACTIVE') throw new ConflictException({ code: 'account_restricted', message: 'The funding account must be active' });
        await this.pins.verify(customerId, i.pin);
      },
      run: async (tx) => {
        const start = new Date();
        const reference = ref();
        const fa = await tx.ledgerAccount.findUniqueOrThrow({ where: { accountId: i.fundingAccountId } });
        const fdLedger = await tx.ledgerAccount.create({ data: { code: `FD-${reference}`, name: `Fixed deposit ${reference}`, type: 'LIABILITY', currency: fa.currency } });
        const fd = await tx.fixedDeposit.create({
          data: { reference, customerId, fundingAccountId: i.fundingAccountId, ledgerAccountId: fdLedger.id, originalPrincipalMinor: BigInt(i.amountMinor), principalMinor: BigInt(i.amountMinor), rateBps: rate!.rateBps, termMonths: i.termMonths, startDate: start, maturityDate: addMonths(start, i.termMonths), renewal: i.renewal },
        });
        try {
          await this.ledger.post({ reference: `FDOPEN-${reference}`, kind: 'FD_OPEN', currency: fa.currency, description: `Fixed deposit ${reference}`, postings: [
            { ledgerAccountId: fa.id, direction: 'DEBIT', amountMinor: BigInt(i.amountMinor), currency: fa.currency },
            { ledgerAccountId: fdLedger.id, direction: 'CREDIT', amountMinor: BigInt(i.amountMinor), currency: fa.currency } ] }, tx);
        } catch (e) {
          if (e instanceof LedgerRejection) throw new UnprocessableEntityException({ code: e.code.toLowerCase(), message: e.code === 'INSUFFICIENT_FUNDS' ? 'Insufficient funds in the funding account' : e.message });
          throw e;
        }
        await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'fd.opened', subjectType: 'FixedDeposit', subjectId: fd.id, metadata: { reference, termMonths: i.termMonths } }, tx);
        await queueNotifications(tx, 'fd.opened', [{ userId: customerId, category: 'DEPOSIT', title: 'Fixed deposit opened', body: `${lkr(BigInt(i.amountMinor))} for ${i.termMonths} months at ${(rate!.rateBps / 100).toFixed(2)}%. Ref ${reference}` }]);
        return this.view(fd);
      },
    });
    return { body: result, replayed };
  }

  // ───────────────────────── early closure ─────────────────────────
  async requestClosure(customerId: string, id: string, reason: string | undefined) {
    const fd = await this.owned(customerId, id);
    if (fd.status !== 'ACTIVE') throw new ConflictException({ code: 'invalid_state', message: 'Only an active deposit can be closed early' });
    if (await this.prisma.fixedDepositClosureRequest.count({ where: { fixedDepositId: id, status: 'PENDING' } })) throw new ConflictException({ code: 'request_in_progress', message: 'An early closure request is already waiting for the bank' });
    const penaltyBps = await this.penaltyBps();
    const est = earlyClosure(fd.principalMinor, fd.rateBps, penaltyBps, fd.startDate, new Date());
    const r = await this.prisma.fixedDepositClosureRequest.create({ data: { fixedDepositId: id, customerId, reason } });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'fd.closure_requested', subjectType: 'FixedDeposit', subjectId: id });
    return { id: r.id, status: r.status, estimate: { interestMinor: num(est.interestMinor), penaltyMinor: num(est.penaltyMinor), payoutMinor: num(est.payoutMinor), note: 'An estimate as of today. The bank decides, and nothing moves until it approves.' } };
  }

  async closureQueue(status: string) {
    const s = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : 'PENDING';
    const rows = await this.prisma.fixedDepositClosureRequest.findMany({ where: { status: s }, orderBy: { createdAt: 'asc' }, take: 100, include: { fixedDeposit: true } });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: rows.map((r) => r.customerId) } } })).map((c) => [c.userId, c]));
    const penaltyBps = await this.penaltyBps();
    return { items: rows.map((r) => { const est = earlyClosure(r.fixedDeposit.principalMinor, r.fixedDeposit.rateBps, penaltyBps, r.fixedDeposit.startDate, new Date()); return { id: r.id, status: r.status, reason: r.reason, createdAt: r.createdAt, reference: r.fixedDeposit.reference, customerName: customers.get(r.customerId)?.fullName, principalMinor: num(r.fixedDeposit.principalMinor), estimate: { interestMinor: num(est.interestMinor), penaltyMinor: num(est.penaltyMinor), payoutMinor: num(est.payoutMinor) } }; }) };
  }

  /** Staff-reviewed early closure: nothing moves until this runs. Interest accrual and payout are ONE atomic transaction. */
  async decideClosure(staffId: string, requestId: string, d: { decision: 'APPROVE' | 'REJECT'; reason?: string }) {
    if (d.decision === 'REJECT' && !d.reason) throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { reason: 'Required' } });
    const penaltyBps = await this.penaltyBps();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const req = await tx.fixedDepositClosureRequest.findUnique({ where: { id: requestId } });
        if (!req) throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
        const claimed = await tx.fixedDepositClosureRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: staffId, decidedAt: new Date(), decisionReason: d.reason ?? null } });
        if (claimed.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This request was already decided' });
        if (d.decision === 'REJECT') {
          await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'fd.closure_rejected', subjectType: 'FixedDeposit', subjectId: req.fixedDepositId, reasonCode: d.reason?.slice(0, 100) }, tx);
          await queueNotifications(tx, 'fd.closure_decided', [{ userId: req.customerId, category: 'DEPOSIT', title: 'Early closure not approved', body: d.reason! }]);
          return { id: requestId, status: 'REJECTED' as const };
        }
        await tx.$queryRaw`SELECT id FROM "FixedDeposit" WHERE id = ${req.fixedDepositId}::uuid FOR UPDATE`;
        const fd = await tx.fixedDeposit.findUniqueOrThrow({ where: { id: req.fixedDepositId } });
        if (fd.status !== 'ACTIVE') throw new ConflictException({ code: 'invalid_state', message: 'The deposit is no longer active' });
        const est = earlyClosure(fd.principalMinor, fd.rateBps, penaltyBps, fd.startDate, new Date());
        const fa = await tx.ledgerAccount.findUniqueOrThrow({ where: { accountId: fd.fundingAccountId } });
        const postings = [
          { ledgerAccountId: await this.ledger.systemAccountId('interestExpense', tx), direction: 'DEBIT' as const, amountMinor: est.interestMinor, currency: fa.currency },
          { ledgerAccountId: fd.ledgerAccountId, direction: 'CREDIT' as const, amountMinor: est.interestMinor, currency: fa.currency },
        ];
        if (est.interestMinor > 0n) await this.ledger.post({ reference: `FDEARLY-INT-${fd.reference}`, kind: 'FD_INTEREST', currency: fa.currency, description: 'Interest to early closure date', postings }, tx);
        await this.ledger.post({ reference: `FDEARLY-PAY-${fd.reference}`, kind: 'FD_EARLY_CLOSURE', currency: fa.currency, description: `Early closure of ${fd.reference}`, postings: [
          { ledgerAccountId: fd.ledgerAccountId, direction: 'DEBIT', amountMinor: est.payoutMinor, currency: fa.currency },
          { ledgerAccountId: fa.id, direction: 'CREDIT', amountMinor: est.payoutMinor, currency: fa.currency } ] }, tx);
        await tx.fixedDeposit.update({ where: { id: fd.id }, data: { status: 'CLOSED' } });
        await tx.fixedDepositClosureRequest.update({ where: { id: requestId }, data: { payoutMinor: est.payoutMinor, penaltyMinor: est.penaltyMinor } });
        await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'fd.closure_approved', subjectType: 'FixedDeposit', subjectId: fd.id, metadata: { payoutMinor: est.payoutMinor.toString(), penaltyMinor: est.penaltyMinor.toString() } }, tx);
        await queueNotifications(tx, 'fd.closed', [{ userId: fd.customerId, category: 'DEPOSIT', title: 'Fixed deposit closed', body: `${lkr(est.payoutMinor)} was paid to your account (early-closure penalty ${lkr(est.penaltyMinor)}). Ref ${fd.reference}` }]);
        return { id: requestId, status: 'APPROVED' as const, payoutMinor: num(est.payoutMinor), penaltyMinor: num(est.penaltyMinor) };
      });
    } catch (e) {
      if (e instanceof LedgerRejection) throw new ConflictException({ code: e.code.toLowerCase(), message: e.message });
      throw e;
    }
  }

  // ───────────────────────── staff: rate card ─────────────────────────
  async setRate(staffId: string, r: { termMonths: number; rateBps: number; minAmountMinor?: number; active?: boolean }) {
    if (!validTerm(r.termMonths)) throw new BadRequestException({ code: 'invalid_term', message: 'Not a supported term' });
    const row = await this.prisma.fixedDepositRate.upsert({
      where: { termMonths: r.termMonths },
      update: { rateBps: r.rateBps, ...(r.minAmountMinor !== undefined ? { minAmountMinor: BigInt(r.minAmountMinor) } : {}), ...(r.active !== undefined ? { active: r.active } : {}), updatedBy: staffId },
      create: { termMonths: r.termMonths, rateBps: r.rateBps, minAmountMinor: BigInt(r.minAmountMinor ?? 1_000_000), active: r.active ?? true, updatedBy: staffId },
    });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'fd.rate_changed', subjectType: 'FixedDepositRate', subjectId: row.id, metadata: { termMonths: r.termMonths, rateBps: r.rateBps } });
    return { termMonths: row.termMonths, rateBps: row.rateBps, minAmountMinor: num(row.minAmountMinor), active: row.active };
  }

  async adminList(status?: string) {
    const rows = await this.prisma.fixedDeposit.findMany({ where: status ? { status } : {}, orderBy: { maturityDate: 'asc' }, take: 100 });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    return { items: rows.map((r) => ({ ...this.view(r), customerName: customers.get(r.customerId)?.fullName, customerNumber: customers.get(r.customerId)?.customerNumber })) };
  }

  // ───────────────────────── job: maturity ─────────────────────────
  /**
   * Restart-safe and idempotent. Each maturity is processed in its own transaction under a row lock (SKIP LOCKED), and
   * its journals use deterministic references (FDM-<ref>-<renewalCount>), so a repeat can never pay twice.
   */
  async runDue(now: Date): Promise<{ matured: number; renewed: number; failed: number }> {
    let matured = 0, renewed = 0, failed = 0;
    const skip = new Set<string>();
    for (let i = 0; i < 500; i++) {
      let outcome = 'none' as 'none' | 'renewed' | 'matured' | 'failed'; // assigned inside the transaction closure
      let touched: string | null = null;
      try {
        await this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "FixedDeposit" WHERE status = 'ACTIVE' AND "maturityDate" <= ${now} ${skip.size ? Prisma.sql`AND id <> ALL(${[...skip]}::uuid[])` : Prisma.empty} ORDER BY "maturityDate" LIMIT 1 FOR UPDATE SKIP LOCKED`);
          if (!rows[0]) return;
          touched = rows[0].id;
          const fd = await tx.fixedDeposit.findUniqueOrThrow({ where: { id: rows[0].id } });
          const interest = simpleInterest(fd.principalMinor, fd.rateBps, fd.termMonths);
          const fa = await tx.ledgerAccount.findUniqueOrThrow({ where: { accountId: fd.fundingAccountId } });
          const cur = fa.currency;
          const tag = `FDM-${fd.reference}-${fd.renewalCount}`;
          if (interest > 0n) {
            await this.ledger.post({ reference: `${tag}-INT`, kind: 'FD_INTEREST', currency: cur, description: `Interest on ${fd.reference}`, postings: [
              { ledgerAccountId: await this.ledger.systemAccountId('interestExpense', tx), direction: 'DEBIT', amountMinor: interest, currency: cur },
              { ledgerAccountId: fd.ledgerAccountId, direction: 'CREDIT', amountMinor: interest, currency: cur } ] }, tx);
          }
          if (fd.renewal === 'PAYOUT') {
            const total = fd.principalMinor + interest;
            await this.ledger.post({ reference: `${tag}-PAY`, kind: 'FD_MATURITY', currency: cur, description: `Maturity of ${fd.reference}`, postings: [
              { ledgerAccountId: fd.ledgerAccountId, direction: 'DEBIT', amountMinor: total, currency: cur },
              { ledgerAccountId: fa.id, direction: 'CREDIT', amountMinor: total, currency: cur } ] }, tx);
            await tx.fixedDeposit.update({ where: { id: fd.id }, data: { status: 'MATURED' } });
            await queueNotifications(tx, 'fd.matured', [{ userId: fd.customerId, category: 'DEPOSIT', title: 'Fixed deposit matured', body: `${lkr(total)} (including ${lkr(interest)} interest) was paid to your account. Ref ${fd.reference}` }]);
            outcome = 'matured';
          } else {
            let principal = fd.principalMinor;
            if (fd.renewal === 'WITH_INTEREST') principal += interest;
            else if (interest > 0n) {
              await this.ledger.post({ reference: `${tag}-PAYINT`, kind: 'FD_MATURITY', currency: cur, description: `Interest paid out on ${fd.reference}`, postings: [
                { ledgerAccountId: fd.ledgerAccountId, direction: 'DEBIT', amountMinor: interest, currency: cur },
                { ledgerAccountId: fa.id, direction: 'CREDIT', amountMinor: interest, currency: cur } ] }, tx);
            }
            // Renewal terms: today's rate card for the same term if it still exists, otherwise the deposit's own rate.
            const current = await tx.fixedDepositRate.findFirst({ where: { termMonths: fd.termMonths, active: true } });
            const newMaturity = addMonths(fd.maturityDate, fd.termMonths);
            await tx.fixedDepositRenewal.create({ data: { fixedDepositId: fd.id, interestMinor: interest, newPrincipalMinor: principal, newMaturityDate: newMaturity } });
            await tx.fixedDeposit.update({ where: { id: fd.id }, data: { principalMinor: principal, rateBps: current?.rateBps ?? fd.rateBps, maturityDate: newMaturity, renewalCount: { increment: 1 } } });
            await queueNotifications(tx, 'fd.renewed', [{ userId: fd.customerId, category: 'DEPOSIT', title: 'Fixed deposit renewed', body: `Interest ${lkr(interest)} ${fd.renewal === 'WITH_INTEREST' ? 'was added to your deposit' : 'was paid to your account'}. New maturity ${newMaturity.toISOString().slice(0, 10)}. Ref ${fd.reference}` }]);
            outcome = 'renewed';
          }
          await this.audit.record({ actorType: 'SYSTEM', action: `fd.${outcome}`, subjectType: 'FixedDeposit', subjectId: fd.id, metadata: { interestMinor: interest.toString() } }, tx);
        }, { maxWait: 10_000, timeout: 20_000 });
      } catch (e) {
        if (!(e instanceof LedgerRejection) && !(e instanceof Prisma.PrismaClientKnownRequestError)) throw e;
        outcome = 'failed'; // e.g. the funding account is closed: leave the deposit for staff, do not spin on it
        if (touched) skip.add(touched);
      }
      if (outcome === 'none') break;
      if (outcome === 'matured') matured++;
      else if (outcome === 'renewed') renewed++;
      else failed++;
    }
    return { matured, renewed, failed };
  }
}
