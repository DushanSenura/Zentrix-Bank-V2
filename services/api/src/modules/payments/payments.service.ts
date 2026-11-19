import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type PaymentKind, type PaymentStatus } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { masked, num } from '../accounts/accounts.service';
import { PinService } from '../auth/pin.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';
import { formatMinor, type PostingInput } from '../ledger/money';
import { BeneficiariesService } from './beneficiaries.service';
import { BILLERS, bankName, parseQr, SIMULATED_BANKS } from './catalog';
import { PolicyService, startOfBankingDay } from './policy.service';

export type DestinationInput =
  | { type: 'OWN'; accountId: string }
  | { type: 'BENEFICIARY'; beneficiaryId: string }
  | { type: 'ZENTRIX'; accountNumber: string }
  | { type: 'INTERBANK'; bankCode: string; accountNumber: string; holderName: string }
  | { type: 'BILL'; billerCode: string; billRef: string }
  | { type: 'QR'; payload: string };

/** Server-resolved destination, persisted with the instruction and used verbatim at execution time. */
type Resolved =
  | { settle: 'INTERNAL'; toAccountId: string; toCustomerId: string; name: string; accountMasked: string; bank: string }
  | { settle: 'INTERBANK'; bankCode: string; accountNumber: string; name: string; accountMasked: string; bank: string }
  | { settle: 'BILL'; billerCode: string; billerName: string; category: string; billRef: string; name: string; accountMasked: string; bank: string };

export interface CreateInput {
  sourceAccountId: string;
  destination: DestinationInput;
  amountMinor: number;
  note?: string;
  scheduledFor?: string;
}

export interface PaymentView {
  id: string;
  reference: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amountMinor: number;
  feeMinor: number;
  totalMinor: number;
  currency: string;
  sourceAccountId: string;
  recipient: { name: string; accountMasked: string; bank: string };
  note: string | null;
  scheduledFor: string | null;
  createdAt: string;
  postedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

class PaymentRefusal extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const FAILURE_TEXT: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  ACCOUNT_RESTRICTED: 'An account involved in this payment cannot take part in it right now',
  LIMIT_EXCEEDED: 'This payment exceeds your transfer limit',
  UNKNOWN_ACCOUNT: 'An account involved in this payment no longer exists',
  CURRENCY_MISMATCH: 'Currency mismatch',
  DUPLICATE_REFERENCE: 'This payment was already processed',
};
const AUTH_WINDOW_MS = 10 * 60_000; // an unauthorised draft expires after 10 minutes
const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const SCOPE = 'POST /v1/payments';

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));
const lkr = (minor: bigint | number) => formatMinor(BigInt(minor)).replace(/^(-?)/, '$1LKR ');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newReference = () => `ZX${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

export function addInterval(d: Date, frequency: string): Date {
  if (frequency === 'WEEKLY') return new Date(d.getTime() + 7 * 86_400_000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // days in target month
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly pins: PinService,
    private readonly policy: PolicyService,
    private readonly beneficiaries: BeneficiariesService,
  ) {}

  // ───────────────────────── views ─────────────────────────
  private toView(p: { id: string; reference: string; kind: PaymentKind; status: PaymentStatus; amountMinor: bigint; feeMinor: bigint; currency: string; sourceAccountId: string; destination: Prisma.JsonValue; note: string | null; scheduledFor: Date | null; createdAt: Date; postedAt: Date | null; failureCode: string | null }): PaymentView {
    const d = p.destination as unknown as Resolved;
    return {
      id: p.id, reference: p.reference, kind: p.kind, status: p.status,
      amountMinor: num(p.amountMinor), feeMinor: num(p.feeMinor), totalMinor: num(p.amountMinor + p.feeMinor), currency: p.currency, sourceAccountId: p.sourceAccountId,
      recipient: { name: d.name, accountMasked: d.accountMasked, bank: d.bank },
      note: p.note, scheduledFor: p.scheduledFor?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), postedAt: p.postedAt?.toISOString() ?? null,
      failureCode: p.failureCode, failureMessage: p.failureCode ? FAILURE_TEXT[p.failureCode] ?? 'The payment could not be completed' : null,
    };
  }

  // ───────────────────────── destination resolution ─────────────────────────
  private async resolveInternal(customerId: string, sourceAccountId: string, where: { id?: string; accountNumber?: string }, mustOwn: boolean): Promise<{ kind: Resolved; owner: string }> {
    const acc = await this.prisma.account.findFirst({ where, include: { customer: true } });
    if (!acc || acc.status === 'CLOSED') throw new NotFoundException({ code: 'recipient_not_found', message: 'No active account matches that recipient' });
    if (mustOwn && acc.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    if (acc.id === sourceAccountId) throw new BadRequestException({ code: 'same_account', message: 'Choose a different account to send to' });
    return { owner: acc.customerId, kind: { settle: 'INTERNAL', toAccountId: acc.id, toCustomerId: acc.customerId, name: acc.customerId === customerId ? (acc.nickname ?? 'My account') : acc.customer.fullName, accountMasked: masked(acc.accountNumber), bank: 'Zentrix Bank' } };
  }

  private async resolve(customerId: string, sourceAccountId: string, d: DestinationInput): Promise<{ kind: PaymentKind; stored: Resolved }> {
    switch (d.type) {
      case 'OWN': return { kind: 'OWN_TRANSFER', stored: (await this.resolveInternal(customerId, sourceAccountId, { id: d.accountId }, true)).kind };
      case 'ZENTRIX': return { kind: 'INTERNAL_TRANSFER', stored: (await this.resolveInternal(customerId, sourceAccountId, { accountNumber: d.accountNumber }, false)).kind };
      case 'QR': {
        const n = parseQr(d.payload);
        if (!n) throw new BadRequestException({ code: 'invalid_qr', message: 'That is not a Zentrix payment code' });
        return { kind: 'QR_PAYMENT', stored: (await this.resolveInternal(customerId, sourceAccountId, { accountNumber: n }, false)).kind };
      }
      case 'BENEFICIARY': {
        const b = await this.beneficiaries.getOwned(customerId, d.beneficiaryId);
        if (b.bankCode === 'ZENTRIX') return { kind: 'INTERNAL_TRANSFER', stored: (await this.resolveInternal(customerId, sourceAccountId, { accountNumber: b.accountNumber }, false)).kind };
        return { kind: 'INTERBANK_TRANSFER', stored: { settle: 'INTERBANK', bankCode: b.bankCode, accountNumber: b.accountNumber, name: b.holderName, accountMasked: masked(b.accountNumber), bank: bankName(b.bankCode) } };
      }
      case 'INTERBANK': {
        if (!SIMULATED_BANKS.some((s) => s.code === d.bankCode)) throw new BadRequestException({ code: 'validation_failed', message: 'Unknown bank' });
        if (/0000$/.test(d.accountNumber)) throw new BadRequestException({ code: 'unverifiable_account', message: 'We could not verify that account number' });
        return { kind: 'INTERBANK_TRANSFER', stored: { settle: 'INTERBANK', bankCode: d.bankCode, accountNumber: d.accountNumber, name: d.holderName, accountMasked: masked(d.accountNumber), bank: bankName(d.bankCode) } };
      }
      case 'BILL': {
        const biller = BILLERS.find((b) => b.code === d.billerCode);
        if (!biller) throw new NotFoundException({ code: 'biller_not_found', message: 'Unknown biller' });
        return { kind: 'BILL_PAYMENT', stored: { settle: 'BILL', billerCode: biller.code, billerName: biller.name, category: biller.category, billRef: d.billRef, name: biller.name, accountMasked: masked(d.billRef), bank: biller.category } };
      }
    }
  }

  private async ownSource(customerId: string, accountId: string) {
    const a = await this.prisma.account.findUnique({ where: { id: accountId }, include: { ledgerAccount: true } });
    if (!a || a.customerId !== customerId) {
      if (a) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Account', id: accountId });
      throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    }
    return a;
  }

  private async dailyUsed(userId: string, now: Date, tx?: Prisma.TransactionClient): Promise<bigint> {
    const r = await (tx ?? this.prisma).paymentInstruction.aggregate({
      _sum: { amountMinor: true },
      where: { initiatorId: userId, status: 'POSTED', kind: { not: 'OWN_TRANSFER' }, postedAt: { gte: startOfBankingDay(now) } },
    });
    return r._sum.amountMinor ?? 0n;
  }

  // ───────────────────────── 1. create (review) ─────────────────────────
  /**
   * Creates a DRAFT. No money moves. Idempotent on (user, Idempotency-Key): the same key + body returns the original
   * result; the same key with a different body is refused. The fee is computed here and never read from the client.
   */
  async create(userId: string, key: string, input: CreateInput): Promise<{ body: PaymentView; replayed: boolean }> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new BadRequestException({ code: 'idempotency_key_invalid', message: 'Idempotency-Key must be 16-64 URL-safe characters' });
    const requestHash = createHash('sha256').update(stable(input)).digest('hex');

    const replay = async () => {
      const rec = await this.prisma.idempotencyRecord.findUnique({ where: { userId_scope_key: { userId, scope: SCOPE, key } } });
      if (!rec) return null;
      if (rec.requestHash !== requestHash) throw new UnprocessableEntityException({ code: 'idempotency_key_reused', message: 'That Idempotency-Key was already used with a different request' });
      if (!rec.responseBody) throw new ConflictException({ code: 'request_in_progress', message: 'This request is still being processed' });
      return { body: rec.responseBody as unknown as PaymentView, replayed: true };
    };
    const existing = await replay();
    if (existing) return existing;

    const now = new Date();
    const src = await this.ownSource(userId, input.sourceAccountId);
    if (src.status !== 'ACTIVE') throw new ConflictException({ code: 'account_restricted', message: `This account is ${src.status.toLowerCase()} and cannot send money` });
    const { kind, stored } = await this.resolve(userId, src.id, input.destination);
    const amount = BigInt(input.amountMinor);
    const fee = await this.policy.feeFor(kind, amount);
    const lim = await this.policy.limits();
    if (amount > lim.perTransferMinor) throw new UnprocessableEntityException({ code: 'limit_exceeded', message: `The limit per payment is ${lkr(lim.perTransferMinor)}` });

    let scheduledFor: Date | null = null;
    if (input.scheduledFor) {
      scheduledFor = new Date(input.scheduledFor);
      if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() < now.getTime() + 60_000 || scheduledFor.getTime() > now.getTime() + 366 * 86_400_000)
        throw new BadRequestException({ code: 'validation_failed', message: 'Choose a date between now and one year ahead', fields: { scheduledFor: 'Invalid date' } });
    } else {
      // Early, friendly checks for immediate payments. They are re-checked authoritatively at execution.
      if (kind !== 'OWN_TRANSFER' && (await this.dailyUsed(userId, now)) + amount > lim.dailyMinor)
        throw new UnprocessableEntityException({ code: 'daily_limit_exceeded', message: 'This would exceed your daily transfer limit' });
      if ((src.ledgerAccount?.balanceMinor ?? 0n) < amount + fee && !src.ledgerAccount?.allowNegative)
        throw new UnprocessableEntityException({ code: 'insufficient_funds', message: 'Insufficient funds for this payment and its fee' });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.idempotencyRecord.create({ data: { key, userId, scope: SCOPE, requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
        const p = await tx.paymentInstruction.create({
          data: {
            reference: newReference(), kind, status: 'AWAITING_AUTHORIZATION', initiatorId: userId, sourceAccountId: src.id, destination: stored as unknown as Prisma.InputJsonValue,
            amountMinor: amount, feeMinor: fee, currency: src.currency, scheduledFor, note: input.note, idempotencyKey: key,
          },
        });
        const view = this.toView(p);
        await tx.idempotencyRecord.update({ where: { userId_scope_key: { userId, scope: SCOPE, key } }, data: { responseStatus: 201, responseBody: view as unknown as Prisma.InputJsonValue } });
        return { body: view, replayed: false };
      });
    } catch (e) {
      // A concurrent request with the same key committed first: serve ITS result, never create a second payment.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await replay();
        if (again) return again;
      }
      throw e;
    }
  }

  // ───────────────────────── 2. authorise (step-up) ─────────────────────────
  async authorize(userId: string, id: string, pin: string): Promise<PaymentView> {
    const p = await this.getOwnedRow(userId, id);
    if (p.status !== 'AWAITING_AUTHORIZATION') return this.afterAuthorized(p.id, userId); // idempotent: terminal/authorised states just report
    if (Date.now() - p.createdAt.getTime() > AUTH_WINDOW_MS) {
      await this.prisma.paymentInstruction.updateMany({ where: { id, status: 'AWAITING_AUTHORIZATION' }, data: { status: 'CANCELLED', failureCode: 'EXPIRED' } });
      throw new ConflictException({ code: 'payment_expired', message: 'This payment expired. Please start again.' });
    }
    await this.pins.verify(userId, pin); // wrong PIN => 401, nothing changes, nothing moves
    const moved = await this.prisma.paymentInstruction.updateMany({ where: { id, status: 'AWAITING_AUTHORIZATION' }, data: { status: 'AUTHORIZED', authorizedAt: new Date() } });
    if (moved.count === 1) {
      await this.prisma.paymentAuthorization.create({ data: { paymentId: id, method: 'PIN', attempts: 1, verifiedAt: new Date(), expiresAt: new Date(Date.now() + AUTH_WINDOW_MS) } });
      await this.audit.record({ actorId: userId, actorType: 'CUSTOMER', action: 'payment.authorized', subjectType: 'PaymentInstruction', subjectId: id });
    }
    return this.afterAuthorized(id, userId);
  }

  private async afterAuthorized(id: string, userId: string): Promise<PaymentView> {
    const p = await this.getOwnedRow(userId, id);
    if (p.status === 'AUTHORIZED' && (!p.scheduledFor || p.scheduledFor.getTime() <= Date.now())) return this.execute(id);
    return this.toView(p);
  }

  // ───────────────────────── 3. execute (post to the ledger) ─────────────────────────
  /**
   * Idempotent: only an AUTHORIZED instruction is executed, under a row lock, so concurrent calls (user retry, worker)
   * post at most one journal. The ledger post, status change, outbox events and audit all commit together.
   */
  async execute(id: string, opts: { skipLocked?: boolean } = {}): Promise<PaymentView> {
    try {
      const out = await this.prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ status: string }[]>(
            opts.skipLocked
              ? Prisma.sql`SELECT status::text AS status FROM "PaymentInstruction" WHERE id=${id}::uuid FOR UPDATE SKIP LOCKED`
              : Prisma.sql`SELECT status::text AS status FROM "PaymentInstruction" WHERE id=${id}::uuid FOR UPDATE`,
          );
          if (!locked[0] || locked[0].status !== 'AUTHORIZED') return null; // someone else is on it / already done
          const p = await tx.paymentInstruction.findUniqueOrThrow({ where: { id } });
          await tx.$queryRaw`SELECT id FROM "User" WHERE id=${p.initiatorId}::uuid FOR UPDATE`; // serialise a customer's limit checks

          const lim = await this.policy.limits();
          if (p.amountMinor > lim.perTransferMinor) throw new PaymentRefusal('LIMIT_EXCEEDED');
          const now = new Date();
          if (p.kind !== 'OWN_TRANSFER' && (await this.dailyUsed(p.initiatorId, now, tx)) + p.amountMinor > lim.dailyMinor) throw new PaymentRefusal('LIMIT_EXCEEDED');

          const dest = p.destination as unknown as Resolved;
          const src = await tx.ledgerAccount.findUniqueOrThrow({ where: { accountId: p.sourceAccountId } });
          const postings: PostingInput[] = [{ ledgerAccountId: src.id, direction: 'DEBIT', amountMinor: p.amountMinor + p.feeMinor, currency: p.currency }];
          let toCustomer: string | null = null;
          if (dest.settle === 'INTERNAL') {
            const to = await tx.ledgerAccount.findUnique({ where: { accountId: dest.toAccountId } });
            if (!to) throw new PaymentRefusal('UNKNOWN_ACCOUNT');
            postings.push({ ledgerAccountId: to.id, direction: 'CREDIT', amountMinor: p.amountMinor, currency: p.currency });
            toCustomer = dest.toCustomerId;
          } else {
            postings.push({ ledgerAccountId: await this.ledger.systemAccountId(dest.settle === 'BILL' ? 'billers' : 'interbank', tx), direction: 'CREDIT', amountMinor: p.amountMinor, currency: p.currency });
          }
          if (p.feeMinor > 0n) postings.push({ ledgerAccountId: await this.ledger.systemAccountId('feeIncome', tx), direction: 'CREDIT', amountMinor: p.feeMinor, currency: p.currency });

          await this.ledger.post({ reference: p.reference, kind: p.kind, currency: p.currency, description: p.note ? `${dest.name}: ${p.note}` : `Payment to ${dest.name}`, paymentId: p.id, postings }, tx);
          const done = await tx.paymentInstruction.update({ where: { id }, data: { status: 'POSTED', postedAt: now } });

          const sender = await tx.customerProfile.findUniqueOrThrow({ where: { userId: p.initiatorId } });
          const notify: { userId: string; category: string; title: string; body: string }[] = [
            { userId: p.initiatorId, category: 'TRANSACTION', title: 'Payment sent', body: `${lkr(p.amountMinor)} sent to ${dest.name}. Ref ${p.reference}` },
          ];
          if (toCustomer && toCustomer !== p.initiatorId) notify.push({ userId: toCustomer, category: 'TRANSACTION', title: 'Money received', body: `${lkr(p.amountMinor)} received from ${sender.fullName}. Ref ${p.reference}` });
          await tx.outboxEvent.create({ data: { topic: 'payment.posted', payload: { paymentId: p.id, notify } } });
          await this.audit.record({ actorId: p.initiatorId, actorType: 'CUSTOMER', action: 'payment.posted', subjectType: 'PaymentInstruction', subjectId: p.id, metadata: { reference: p.reference, kind: p.kind } }, tx);
          return done;
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
      if (out) return this.toView(out);
    } catch (e) {
      const code = e instanceof LedgerRejection ? e.code : e instanceof PaymentRefusal ? e.code : null;
      if (!code) throw e; // unexpected (e.g. DB outage): leave AUTHORIZED; the worker retries safely
      await this.markFailed(id, code);
    }
    return this.toView(await this.prisma.paymentInstruction.findUniqueOrThrow({ where: { id } }));
  }

  private async markFailed(id: string, code: string) {
    const r = await this.prisma.paymentInstruction.updateMany({ where: { id, status: 'AUTHORIZED' }, data: { status: 'FAILED', failureCode: code } });
    if (r.count !== 1) return;
    const p = await this.prisma.paymentInstruction.findUniqueOrThrow({ where: { id } });
    const dest = p.destination as unknown as Resolved;
    await this.prisma.outboxEvent.create({
      data: { topic: 'payment.failed', payload: { paymentId: id, notify: [{ userId: p.initiatorId, category: 'TRANSACTION', title: 'Payment failed', body: `${lkr(p.amountMinor)} to ${dest.name} was not sent: ${FAILURE_TEXT[code] ?? 'declined'}. Ref ${p.reference}` }] } },
    });
    await this.audit.record({ actorId: p.initiatorId, actorType: 'CUSTOMER', action: 'payment.failed', subjectType: 'PaymentInstruction', subjectId: id, reasonCode: code });
    if (p.scheduledPaymentId) await this.prisma.scheduledPayment.updateMany({ where: { id: p.scheduledPaymentId }, data: { lastFailure: code } });
  }

  // ───────────────────────── reads / cancel ─────────────────────────
  private async getOwnedRow(userId: string, id: string) {
    const p = await this.prisma.paymentInstruction.findUnique({ where: { id } });
    if (!p || p.initiatorId !== userId) {
      if (p) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', userId, { resource: 'PaymentInstruction', id });
      throw new NotFoundException({ code: 'not_found', message: 'Payment not found' });
    }
    return p;
  }

  async get(userId: string, id: string) { return this.toView(await this.getOwnedRow(userId, id)); }

  /** For reconciling an unknown outcome: did my create request reach the bank? */
  async getByKey(userId: string, key: string) {
    const p = await this.prisma.paymentInstruction.findUnique({ where: { initiatorId_idempotencyKey: { initiatorId: userId, idempotencyKey: key } } });
    if (!p) throw new NotFoundException({ code: 'not_found', message: 'No payment was recorded for that request' });
    return this.toView(p);
  }

  async list(userId: string, scheduledOnly: boolean) {
    const rows = await this.prisma.paymentInstruction.findMany({
      where: { initiatorId: userId, ...(scheduledOnly ? { status: 'AUTHORIZED', scheduledFor: { not: null } } : {}) },
      orderBy: scheduledOnly ? { scheduledFor: 'asc' } : { createdAt: 'desc' },
      take: 50,
    });
    return { items: rows.map((r) => this.toView(r)) };
  }

  async cancel(userId: string, id: string): Promise<PaymentView> {
    await this.getOwnedRow(userId, id);
    const r = await this.prisma.paymentInstruction.updateMany({
      where: { id, initiatorId: userId, OR: [{ status: 'AWAITING_AUTHORIZATION' }, { status: 'AUTHORIZED', scheduledFor: { gt: new Date() } }] },
      data: { status: 'CANCELLED', failureCode: 'CANCELLED_BY_CUSTOMER' },
    });
    if (r.count !== 1) throw new ConflictException({ code: 'not_cancellable', message: 'This payment can no longer be cancelled' });
    await this.audit.record({ actorId: userId, actorType: 'CUSTOMER', action: 'payment.cancelled', subjectType: 'PaymentInstruction', subjectId: id });
    return this.get(userId, id);
  }

  async adminList(status?: string, limit = 50) {
    const s = (['AWAITING_AUTHORIZATION', 'AUTHORIZED', 'POSTED', 'FAILED', 'CANCELLED', 'REVERSED'] as const).find((x) => x === status);
    const rows = await this.prisma.paymentInstruction.findMany({ where: s ? { status: s } : {}, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
    const names = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.initiatorId))] } }, select: { userId: true, fullName: true, customerNumber: true } })).map((c) => [c.userId, c]));
    return { items: rows.map((r) => ({ ...this.toView(r), customerName: names.get(r.initiatorId)?.fullName, customerNumber: names.get(r.initiatorId)?.customerNumber })) };
  }

  // ───────────────────────── recurring (standing instructions) ─────────────────────────
  async createRecurring(userId: string, i: { sourceAccountId: string; destination: DestinationInput; amountMinor: number; frequency: 'WEEKLY' | 'MONTHLY'; startDate: string; endDate?: string; note?: string; pin: string }) {
    const src = await this.ownSource(userId, i.sourceAccountId);
    const { stored } = await this.resolve(userId, src.id, i.destination);
    const start = new Date(i.startDate);
    const end = i.endDate ? new Date(i.endDate) : null;
    const now = Date.now();
    if (Number.isNaN(start.getTime()) || start.getTime() < now + 60_000 || start.getTime() > now + 366 * 86_400_000 || (end && (Number.isNaN(end.getTime()) || end <= start)))
      throw new BadRequestException({ code: 'validation_failed', message: 'Check the start and end dates', fields: { startDate: 'Invalid date' } });
    const lim = await this.policy.limits();
    if (BigInt(i.amountMinor) > lim.perTransferMinor) throw new UnprocessableEntityException({ code: 'limit_exceeded', message: `The limit per payment is ${lkr(lim.perTransferMinor)}` });
    await this.pins.verify(userId, i.pin); // the standing instruction itself is PIN-authorised
    const row = await this.prisma.scheduledPayment.create({
      data: { customerId: userId, sourceAccountId: src.id, destination: stored as unknown as Prisma.InputJsonValue, amountMinor: BigInt(i.amountMinor), currency: src.currency, note: i.note, frequency: i.frequency, nextRunAt: start, endAt: end },
    });
    await this.audit.record({ actorId: userId, actorType: 'CUSTOMER', action: 'scheduled_payment.created', subjectType: 'ScheduledPayment', subjectId: row.id });
    return this.recurringView(row);
  }

  private recurringView(r: { id: string; destination: Prisma.JsonValue; amountMinor: bigint; currency: string; frequency: string; nextRunAt: Date; endAt: Date | null; active: boolean; lastRunAt: Date | null; lastFailure: string | null; note: string | null }) {
    const d = r.destination as unknown as Resolved;
    return { id: r.id, recipient: { name: d.name, accountMasked: d.accountMasked, bank: d.bank }, amountMinor: num(r.amountMinor), currency: r.currency, frequency: r.frequency, nextRunAt: r.nextRunAt.toISOString(), endAt: r.endAt?.toISOString() ?? null, active: r.active, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastFailure: r.lastFailure ? FAILURE_TEXT[r.lastFailure] ?? r.lastFailure : null, note: r.note };
  }

  async listRecurring(userId: string) {
    const rows = await this.prisma.scheduledPayment.findMany({ where: { customerId: userId, active: true }, orderBy: { nextRunAt: 'asc' }, take: 50 });
    return { items: rows.map((r) => this.recurringView(r)) };
  }

  async cancelRecurring(userId: string, id: string) {
    const r = await this.prisma.scheduledPayment.updateMany({ where: { id, customerId: userId, active: true }, data: { active: false } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Scheduled payment not found' });
    await this.audit.record({ actorId: userId, actorType: 'CUSTOMER', action: 'scheduled_payment.cancelled', subjectType: 'ScheduledPayment', subjectId: id });
  }

  // ───────────────────────── background processing (called by the worker) ─────────────────────────
  /**
   * Restart-safe and idempotent. Safe to call concurrently from several workers:
   *  1. expire stale unauthorised drafts
   *  2. turn due standing instructions into AUTHORIZED instructions (deterministic reference => at most one per run)
   *  3. execute due / stuck AUTHORIZED instructions (row-locked, SKIP LOCKED)
   */
  async runDue(now: Date = new Date()): Promise<{ expired: number; recurringCreated: number; executed: number; failed: number }> {
    const expired = (await this.prisma.paymentInstruction.updateMany({ where: { status: 'AWAITING_AUTHORIZATION', createdAt: { lt: new Date(now.getTime() - AUTH_WINDOW_MS) } }, data: { status: 'CANCELLED', failureCode: 'EXPIRED' } })).count;

    let recurringCreated = 0;
    for (let i = 0; i < 200; i++) {
      const made = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "ScheduledPayment" WHERE active AND "nextRunAt" <= ${now} AND ("endAt" IS NULL OR "nextRunAt" <= "endAt") ORDER BY "nextRunAt" LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (!rows[0]) return null;
        const sp = await tx.scheduledPayment.findUniqueOrThrow({ where: { id: rows[0].id } });
        const next = addInterval(sp.nextRunAt, sp.frequency);
        const ref = `SP${sp.id.replace(/-/g, '').slice(0, 10).toUpperCase()}${sp.nextRunAt.toISOString().slice(0, 10).replace(/-/g, '')}`;
        const exists = await tx.paymentInstruction.findUnique({ where: { reference: ref } });
        if (!exists) {
          const d = sp.destination as unknown as Resolved;
          const fee = await this.policy.feeFor(d.settle === 'INTERBANK' ? 'INTERBANK_TRANSFER' : d.settle === 'BILL' ? 'BILL_PAYMENT' : 'INTERNAL_TRANSFER', sp.amountMinor);
          await tx.paymentInstruction.create({
            data: { reference: ref, kind: d.settle === 'INTERBANK' ? 'INTERBANK_TRANSFER' : d.settle === 'BILL' ? 'BILL_PAYMENT' : 'INTERNAL_TRANSFER', status: 'AUTHORIZED', initiatorId: sp.customerId, sourceAccountId: sp.sourceAccountId, destination: sp.destination as Prisma.InputJsonValue, amountMinor: sp.amountMinor, feeMinor: fee, currency: sp.currency, scheduledFor: sp.nextRunAt, authorizedAt: now, note: sp.note, scheduledPaymentId: sp.id },
          });
        }
        await tx.scheduledPayment.update({ where: { id: sp.id }, data: { nextRunAt: next, lastRunAt: now, ...(sp.endAt && next > sp.endAt ? { active: false } : {}) } });
        return !exists;
      });
      if (made === null) break;
      if (made) recurringCreated++;
    }

    let executed = 0, failed = 0;
    const due = await this.prisma.paymentInstruction.findMany({
      where: { status: 'AUTHORIZED', OR: [{ scheduledFor: { lte: now } }, { scheduledFor: null, authorizedAt: { lt: new Date(now.getTime() - 60_000) } }] },
      orderBy: { createdAt: 'asc' }, take: 100, select: { id: true },
    });
    for (const d of due) {
      const v = await this.execute(d.id, { skipLocked: true });
      if (v.status === 'POSTED') executed++;
      else if (v.status === 'FAILED') failed++;
    }
    return { expired, recurringCreated, executed, failed };
  }
}
