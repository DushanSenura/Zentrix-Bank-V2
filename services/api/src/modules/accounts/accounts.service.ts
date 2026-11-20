import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AccountStatus } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';

/** Minor-unit amounts cross the API as JSON numbers; refuse anything that would lose precision. */
export function num(b: bigint): number {
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount out of range');
  return Number(b);
}
export const masked = (n: string) => `${'*'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;

const DEFAULT_MAX_ACCOUNTS = 6; // V1 product default; override via SystemConfiguration 'accounts.maxPerCustomer'

const ALLOWED: Record<AccountStatus, AccountStatus[]> = {
  ACTIVE: ['FROZEN', 'SUSPENDED', 'CLOSED'],
  FROZEN: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  private async maxAccounts(): Promise<number> {
    const c = await this.prisma.systemConfiguration.findUnique({ where: { key: 'accounts.maxPerCustomer' } });
    return typeof c?.value === 'number' ? c.value : DEFAULT_MAX_ACCOUNTS;
  }

  private view(a: { id: string; accountNumber: string; nickname: string | null; currency: string; status: AccountStatus; openedAt: Date; product: { code: string; name: string; kind: string; interestRateBps: number }; ledgerAccount: { balanceMinor: bigint } | null }) {
    return {
      id: a.id,
      accountNumberMasked: masked(a.accountNumber),
      nickname: a.nickname,
      productCode: a.product.code,
      productName: a.product.name,
      kind: a.product.kind,
      interestRateBps: a.product.interestRateBps,
      currency: a.currency,
      status: a.status,
      openedAt: a.openedAt,
      balanceMinor: num(a.ledgerAccount?.balanceMinor ?? 0n),
    };
  }

  async list(customerId: string) {
    const rows = await this.prisma.account.findMany({
      where: { customerId, status: { not: 'CLOSED' } },
      include: { product: true, ledgerAccount: true },
      orderBy: { openedAt: 'asc' },
    });
    const items = rows.map((r) => this.view(r));
    return { items, totalBalanceMinor: items.filter((i) => i.currency === 'LKR').reduce((s, i) => s + i.balanceMinor, 0) };
  }

  /** Ownership is enforced in the query. A foreign or unknown id is a 404; a foreign id also records a security event. */
  async getOwned(customerId: string, accountId: string) {
    const a = await this.prisma.account.findUnique({ where: { id: accountId }, include: { product: true, ledgerAccount: true } });
    if (!a || a.customerId !== customerId) {
      if (a) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Account', id: accountId });
      throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    }
    return a;
  }

  async detail(customerId: string, accountId: string) {
    return this.view(await this.getOwned(customerId, accountId));
  }

  /** Keyset-paginated history straight from the postings (the source of truth). */
  async transactions(customerId: string, accountId: string, limit: number, cursor?: string) {
    const acc = await this.getOwned(customerId, accountId);
    const la = acc.ledgerAccount;
    if (!la) return { items: [], nextCursor: null };
    let before: { at: Date; id: string } | undefined;
    if (cursor) {
      const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
      if (!at || !id || Number.isNaN(Date.parse(at))) throw new BadRequestException({ code: 'validation_failed', message: 'Invalid cursor' });
      before = { at: new Date(at), id };
    }
    const rows = await this.prisma.ledgerPosting.findMany({
      where: { ledgerAccountId: la.id, ...(before ? { OR: [{ createdAt: { lt: before.at } }, { createdAt: before.at, id: { lt: before.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { journal: true },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((p) => ({
        id: p.id,
        reference: p.journal.reference,
        kind: p.journal.kind,
        description: p.journal.description,
        // Customer accounts are credit-normal: a CREDIT is money in.
        amountMinor: num(p.direction === 'CREDIT' ? p.amountMinor : -p.amountMinor),
        currency: p.currency,
        status: p.journal.status,
        postedAt: p.createdAt,
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  // ───────────────────────── products & applications ─────────────────────────
  products() {
    return this.prisma.accountProduct
      .findMany({ where: { active: true, kind: { in: ['SAVINGS', 'CURRENT', 'FOREIGN_CURRENCY'] } }, orderBy: { code: 'asc' } })
      .then((rows) => ({ items: rows.map((p) => ({ code: p.code, name: p.name, kind: p.kind, currency: p.currency, minOpeningMinor: num(p.minOpeningMinor), interestRateBps: p.interestRateBps })) }));
  }

  async apply(customerId: string, productCode: string, nickname?: string) {
    const product = await this.prisma.accountProduct.findFirst({ where: { code: productCode, active: true, kind: { in: ['SAVINGS', 'CURRENT', 'FOREIGN_CURRENCY'] } } });
    if (!product) throw new NotFoundException({ code: 'product_not_found', message: 'That account type is not available' });
    const max = await this.maxAccounts();
    const [open, pending] = await Promise.all([
      this.prisma.account.count({ where: { customerId, status: { not: 'CLOSED' } } }),
      this.prisma.accountApplication.count({ where: { customerId, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
    ]);
    if (open + pending >= max) throw new ConflictException({ code: 'account_limit', message: `You can hold at most ${max} accounts (including pending applications)` });
    const app = await this.prisma.accountApplication.create({ data: { customerId, productId: product.id, requestedNickname: nickname } });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'account.application_submitted', subjectType: 'AccountApplication', subjectId: app.id });
    return { id: app.id, status: app.status };
  }

  async myApplications(customerId: string) {
    const rows = await this.prisma.accountApplication.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, include: { product: true }, take: 50 });
    return {
      items: rows.map((a) => ({ id: a.id, productName: a.product.name, status: a.status, createdAt: a.createdAt, decisionReason: a.status === 'REJECTED' ? a.decisionReason : null, accountId: a.accountId })),
    };
  }

  async queue(status: string) {
    const s = (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'] as const).find((x) => x === status) ?? 'SUBMITTED';
    const rows = await this.prisma.accountApplication.findMany({ where: { status: s }, orderBy: { createdAt: 'asc' }, take: 100, include: { product: true, customer: { include: { user: { select: { email: true } } } } } });
    return {
      items: rows.map((a) => ({
        id: a.id, status: a.status, createdAt: a.createdAt, productCode: a.product.code, productName: a.product.name, minOpeningMinor: num(a.product.minOpeningMinor),
        customerName: a.customer.fullName, customerNumber: a.customer.customerNumber, kycStatus: a.customer.kycStatus, nickname: a.requestedNickname,
      })),
    };
  }

  /**
   * Staff decision. Approval creates the account and, in the SAME database transaction, posts the opening deposit
   * (cash received at the branch) to the ledger. Either everything commits or nothing does.
   */
  async decide(staffId: string, applicationId: string, d: { decision: 'APPROVE' | 'REJECT'; reason?: string; openingDepositMinor?: number }) {
    if (d.decision === 'REJECT' && !d.reason) throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { reason: 'Required' } });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const app = await tx.accountApplication.findUnique({ where: { id: applicationId }, include: { product: true, customer: { include: { user: true } } } });
        if (!app) throw new NotFoundException({ code: 'not_found', message: 'Application not found' });
        const claimed = await tx.accountApplication.updateMany({
          where: { id: applicationId, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } },
          data: { status: d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: staffId, decidedAt: new Date(), decisionReason: d.reason ?? null },
        });
        if (claimed.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This application was already decided' });

        if (d.decision === 'REJECT') {
          await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'account.application_rejected', subjectType: 'AccountApplication', subjectId: applicationId, reasonCode: d.reason?.slice(0, 100) }, tx);
          await tx.outboxEvent.create({ data: { topic: 'account.application_decided', payload: { userId: app.customerId, applicationId, decision: 'REJECTED' } } });
          return { id: applicationId, status: 'REJECTED' as const };
        }

        if (app.customer.user.status !== 'ACTIVE' || app.customer.kycStatus !== 'APPROVED') throw new ConflictException({ code: 'customer_not_verified', message: 'The customer is not verified' });
        const deposit = BigInt(d.openingDepositMinor ?? 0);
        if (deposit < app.product.minOpeningMinor) throw new BadRequestException({ code: 'opening_deposit_required', message: 'The opening deposit is below the product minimum', fields: { openingDepositMinor: `Minimum is ${num(app.product.minOpeningMinor)}` } });

        let accountNumber = '';
        for (let i = 0; i < 8; i++) {
          accountNumber = `${randomInt(1, 10)}${String(randomInt(0, 1e10)).padStart(10, '0')}`;
          if (!(await tx.account.findUnique({ where: { accountNumber } }))) break;
        }
        const account = await tx.account.create({
          data: {
            customerId: app.customerId, productId: app.productId, accountNumber, nickname: app.requestedNickname, currency: app.product.currency,
            ledgerAccount: { create: { code: `ACC-${accountNumber}`, name: `Customer account ${accountNumber}`, type: 'LIABILITY', currency: app.product.currency, allowNegative: app.product.allowOverdraft } },
            statusHistory: { create: { toStatus: 'ACTIVE', reasonCode: 'APPLICATION_APPROVED', actorId: staffId } },
          },
          include: { ledgerAccount: true },
        });
        if (deposit > 0n) {
          await this.ledger.post(
            {
              reference: `OPEN-${applicationId}`, kind: 'ACCOUNT_OPENING', currency: app.product.currency, description: 'Opening deposit (cash at branch)',
              postings: [
                { ledgerAccountId: await this.ledger.systemAccountId('cash', tx), direction: 'DEBIT', amountMinor: deposit, currency: app.product.currency },
                { ledgerAccountId: account.ledgerAccount!.id, direction: 'CREDIT', amountMinor: deposit, currency: app.product.currency },
              ],
            },
            tx,
          );
        }
        await tx.accountApplication.update({ where: { id: applicationId }, data: { accountId: account.id, openingDepositMinor: deposit } });
        await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'account.application_approved', subjectType: 'Account', subjectId: account.id, metadata: { applicationId } }, tx);
        await tx.outboxEvent.create({ data: { topic: 'account.opened', payload: { userId: app.customerId, accountId: account.id } } });
        return { id: applicationId, status: 'APPROVED' as const, accountId: account.id };
      });
    } catch (e) {
      if (e instanceof LedgerRejection) throw new ConflictException({ code: e.code.toLowerCase(), message: e.message });
      throw e;
    }
  }

  // ───────────────────────── staff account administration ─────────────────────────
  async search(q: string) {
    const term = q.trim();
    if (term.length < 3) throw new BadRequestException({ code: 'validation_failed', message: 'Enter at least 3 characters' });
    const rows = await this.prisma.account.findMany({
      where: { OR: [{ accountNumber: { contains: term } }, { customer: { customerNumber: { contains: term.toUpperCase() } } }, { customer: { fullName: { contains: term, mode: 'insensitive' } } }] },
      include: { product: true, ledgerAccount: true, customer: true },
      take: 25,
      orderBy: { openedAt: 'desc' },
    });
    return { items: rows.map((r) => ({ ...this.view(r), accountNumber: r.accountNumber, customerName: r.customer.fullName, customerNumber: r.customer.customerNumber })) };
  }

  async setStatus(staffId: string, accountId: string, to: AccountStatus, reasonCode: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: AccountStatus; customerId: string }[]>(Prisma.sql`SELECT id, status::text AS status, "customerId" FROM "Account" WHERE id = ${accountId}::uuid FOR UPDATE`);
      const cur = rows[0];
      if (!cur) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
      if (!ALLOWED[cur.status].includes(to)) throw new ConflictException({ code: 'invalid_transition', message: `Cannot change a ${cur.status.toLowerCase()} account to ${to.toLowerCase()}` });
      if (to === 'CLOSED') {
        const la = await tx.ledgerAccount.findUnique({ where: { accountId } });
        if (la && la.balanceMinor !== 0n) throw new ConflictException({ code: 'balance_not_zero', message: 'The account balance must be zero before closing' });
      }
      await tx.account.update({ where: { id: accountId }, data: { status: to, closedAt: to === 'CLOSED' ? new Date() : null } });
      await tx.accountStatusHistory.create({ data: { accountId, fromStatus: cur.status, toStatus: to, reasonCode, actorId: staffId } });
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: `account.status_${to.toLowerCase()}`, subjectType: 'Account', subjectId: accountId, reasonCode }, tx);
      await tx.outboxEvent.create({ data: { topic: 'account.status_changed', payload: { userId: cur.customerId, accountId, status: to } } });
      return { id: accountId, status: to };
    });
  }

  forbidden(): never {
    throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this resource' });
  }
}
