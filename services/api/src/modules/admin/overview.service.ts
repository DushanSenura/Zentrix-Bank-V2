import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type UserStatus } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { toCsv } from '../../common/csv';
import { PrismaService } from '../../common/prisma.service';
import { ENV, type Env } from '../../config/env';
import { decrypt, maskTail } from '../../security/crypto';
import { num } from '../accounts/accounts.service';
import { startOfBankingDay } from '../payments/policy.service';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString();
const clampLimit = (n: number | undefined, def = 25, max = 100) => Math.min(Math.max(n ?? def, 1), max);

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(ENV) private readonly env: Env) {}

  // ───────────────────────── dashboard ─────────────────────────
  /** Real aggregates only. A section appears only if the caller holds the permission that governs its data. */
  async dashboard(perms: ReadonlySet<string>) {
    const out: Record<string, unknown> = { generatedAt: new Date().toISOString() };
    const now = new Date();
    const today = startOfBankingDay(now);

    if (perms.has('customers.read')) {
      const [total, active, pendingKyc, suspended] = await Promise.all([
        this.prisma.user.count({ where: { type: 'CUSTOMER' } }),
        this.prisma.user.count({ where: { type: 'CUSTOMER', status: 'ACTIVE' } }),
        this.prisma.customerProfile.count({ where: { kycStatus: 'SUBMITTED' } }),
        this.prisma.user.count({ where: { type: 'CUSTOMER', status: 'SUSPENDED' } }),
      ]);
      out.customers = { total, active, pendingKyc, suspended };
    }

    if (perms.has('transactions.read') || perms.has('reports.read')) {
      const [dep, loan, todayAgg, failed, series] = await Promise.all([
        this.prisma.$queryRaw<{ v: bigint }[]>`SELECT COALESCE(SUM("balanceMinor"),0)::bigint AS v FROM "LedgerAccount" WHERE type = 'LIABILITY' AND currency = 'LKR'`,
        this.prisma.$queryRaw<{ v: bigint }[]>`SELECT COALESCE(SUM("balanceMinor"),0)::bigint AS v FROM "LedgerAccount" WHERE code LIKE 'LOAN-%'`,
        this.prisma.paymentInstruction.aggregate({ _count: true, _sum: { amountMinor: true, feeMinor: true }, where: { status: 'POSTED', kind: { notIn: ['OWN_TRANSFER', 'LOAN_INSTALMENT'] }, postedAt: { gte: today } } }),
        this.prisma.paymentInstruction.count({ where: { status: 'FAILED', updatedAt: { gte: today } } }),
        this.prisma.$queryRaw<{ day: Date; count: bigint; volume: bigint }[]>`
          SELECT (date_trunc('day', "postedAt" AT TIME ZONE 'Asia/Colombo'))::date AS day, COUNT(*)::bigint AS count, COALESCE(SUM("amountMinor"),0)::bigint AS volume
          FROM "PaymentInstruction" WHERE status = 'POSTED' AND kind NOT IN ('OWN_TRANSFER','LOAN_INSTALMENT') AND "postedAt" >= ${new Date(today.getTime() - 13 * 86_400_000)}
          GROUP BY 1 ORDER BY 1`,
      ]);
      out.finance = {
        depositLiabilitiesMinor: num(dep[0]!.v), loanBalancesMinor: num(loan[0]!.v),
        today: { transfers: todayAgg._count, volumeMinor: num(todayAgg._sum.amountMinor ?? 0n), feesMinor: num(todayAgg._sum.feeMinor ?? 0n), failed },
        series: series.map((s) => ({ day: s.day.toISOString().slice(0, 10), count: Number(s.count), volumeMinor: num(s.volume) })),
      };
    }

    const pending: Record<string, number> = {};
    const jobs: Promise<void>[] = [];
    const add = (cond: boolean, key: string, f: () => Promise<number>) => { if (cond) jobs.push(f().then((n) => { pending[key] = n; })); };
    add(perms.has('kyc.review'), 'kyc', () => this.prisma.customerProfile.count({ where: { kycStatus: 'SUBMITTED' } }));
    add(perms.has('accounts.review'), 'accounts', () => this.prisma.accountApplication.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }));
    add(perms.has('cards.review'), 'cards', () => this.prisma.card.count({ where: { status: 'PENDING_APPROVAL' } }));
    add(perms.has('loans.review'), 'loanApplications', () => this.prisma.loanApplication.count({ where: { status: 'SUBMITTED' } }));
    add(perms.has('loans.approve'), 'loanApprovals', () => this.prisma.approvalRequest.count({ where: { kind: 'LOAN_DISBURSEMENT', status: 'PENDING' } }));
    add(perms.has('deposits.manage'), 'depositClosures', () => this.prisma.fixedDepositClosureRequest.count({ where: { status: 'PENDING' } }));
    add(perms.has('transactions.adjust'), 'ledgerApprovals', () => this.prisma.approvalRequest.count({ where: { kind: { in: ['PAYMENT_REVERSAL', 'LEDGER_ADJUSTMENT'] }, status: 'PENDING' } }));
    await Promise.all(jobs);
    out.pending = pending;

    if (perms.has('audit.read')) {
      const rows = await this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
      out.recentAudit = rows.map((r) => ({ id: r.id, action: r.action, actorType: r.actorType, subjectType: r.subjectType, createdAt: r.createdAt }));
      out.securityAlerts24h = await this.prisma.securityEvent.count({ where: { severity: 'HIGH', createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
    }
    return out;
  }

  // ───────────────────────── customers ─────────────────────────
  async customers(q: { q?: string; status?: string; kyc?: string; limit?: number; cursor?: string }) {
    const limit = clampLimit(q.limit);
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = {
      type: 'CUSTOMER',
      ...(q.status && ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'CLOSED'].includes(q.status) ? { status: q.status as UserStatus } : {}),
      ...(q.kyc && ['NOT_SUBMITTED', 'SUBMITTED', 'MORE_INFO_REQUESTED', 'APPROVED', 'REJECTED'].includes(q.kyc) ? { customer: { kycStatus: q.kyc as never } } : {}),
      ...(term && term.length >= 2 ? { OR: [{ username: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }, { customer: { fullName: { contains: term, mode: 'insensitive' } } }, { customer: { customerNumber: { contains: term.toUpperCase() } } }] } : {}),
    };
    if (q.cursor) {
      const [at, id] = unb64(q.cursor).split('|');
      if (!at || !id || Number.isNaN(Date.parse(at))) throw new BadRequestException({ code: 'validation_failed', message: 'Invalid cursor' });
      where.AND = [{ OR: [{ createdAt: { lt: new Date(at) } }, { createdAt: new Date(at), id: { lt: id } }] }];
    }
    const rows = await this.prisma.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: { customer: true } });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((u) => ({ userId: u.id, customerNumber: u.customer?.customerNumber, fullName: u.customer?.fullName, email: u.email, status: u.status, kycStatus: u.customer?.kycStatus, createdAt: u.createdAt })),
      nextCursor: rows.length > limit && last ? b64(`${last.createdAt.toISOString()}|${last.id}`) : null,
    };
  }

  /** Customer 360. Sensitive identity data is masked; staff never see the full national ID here. */
  async customerDetail(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, type: 'CUSTOMER' }, include: { customer: true } });
    if (!user || !user.customer) throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });
    const key = Buffer.from(this.env.DATA_ENCRYPTION_KEY, 'base64');
    const [accounts, cards, loans, deposits, payments, sessions, logins, failed24h] = await Promise.all([
      this.prisma.account.findMany({ where: { customerId: userId }, include: { product: true, ledgerAccount: true }, orderBy: { openedAt: 'asc' } }),
      this.prisma.card.findMany({ where: { customerId: userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.loan.findMany({ where: { customerId: userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.fixedDeposit.findMany({ where: { customerId: userId }, orderBy: { startDate: 'desc' }, take: 20 }),
      this.prisma.paymentInstruction.findMany({ where: { initiatorId: userId }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.prisma.loginHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 5 }),
      this.prisma.loginHistory.count({ where: { userId, success: false, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    ]);
    const loanBalances = new Map((await this.prisma.ledgerAccount.findMany({ where: { id: { in: loans.map((l) => l.ledgerAccountId) } } })).map((l) => [l.id, l.balanceMinor]));
    const c = user.customer;
    return {
      userId: user.id, customerNumber: c.customerNumber, fullName: c.fullName, username: user.username, email: user.email, phone: user.phone, status: user.status, createdAt: user.createdAt,
      kyc: { status: c.kycStatus, note: c.kycNote, reviewedAt: c.kycReviewedAt, dateOfBirth: c.dateOfBirth?.toISOString().slice(0, 10) ?? null, nationalIdMasked: c.nationalIdEnc ? maskTail(decrypt(c.nationalIdEnc, key)) : null, address: c.address },
      security: { activeSessions: sessions, failedLogins24h: failed24h, hasPin: !!user.pinHash, lockedUntil: user.lockedUntil, recentLogins: logins.map((l) => ({ at: l.createdAt, success: l.success, ip: l.ip })) },
      accounts: accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, product: a.product.name, status: a.status, balanceMinor: num(a.ledgerAccount?.balanceMinor ?? 0n), currency: a.currency })),
      cards: cards.map((k) => ({ id: k.id, kind: k.kind, status: k.status, last4: k.last4 })),
      loans: loans.map((l) => ({ id: l.id, reference: l.reference, status: l.status, principalMinor: num(l.principalMinor), outstandingMinor: num(loanBalances.get(l.ledgerAccountId) ?? 0n) })),
      fixedDeposits: deposits.map((d) => ({ id: d.id, reference: d.reference, status: d.status, principalMinor: num(d.principalMinor), maturityDate: d.maturityDate })),
      recentPayments: payments.map((p) => ({ id: p.id, reference: p.reference, kind: p.kind, status: p.status, amountMinor: num(p.amountMinor), createdAt: p.createdAt })),
    };
  }

  async suspend(staffId: string, userId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findFirst({ where: { id: userId, type: 'CUSTOMER' } });
      if (!u) throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });
      const r = await tx.user.updateMany({ where: { id: userId, status: { in: ['ACTIVE', 'PENDING_VERIFICATION'] } }, data: { status: 'SUSPENDED' } });
      if (r.count !== 1) throw new ConflictException({ code: 'invalid_state', message: 'This customer cannot be suspended in their current state' });
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }); // signed out everywhere, immediately
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'customer.suspended', subjectType: 'User', subjectId: userId, reasonCode: reason.slice(0, 100) }, tx);
      await tx.securityEvent.create({ data: { userId, kind: 'CUSTOMER_SUSPENDED', severity: 'WARN', detail: { by: staffId } } });
      return { userId, status: 'SUSPENDED' as const };
    });
  }

  async restore(staffId: string, userId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findFirst({ where: { id: userId, type: 'CUSTOMER', status: 'SUSPENDED' }, include: { customer: true } });
      if (!u) throw new ConflictException({ code: 'invalid_state', message: 'This customer is not suspended' });
      const next: UserStatus = u.customer?.kycStatus === 'APPROVED' ? 'ACTIVE' : 'PENDING_VERIFICATION'; // restoring never skips verification
      await tx.user.update({ where: { id: userId }, data: { status: next, failedLogins: 0, lockedUntil: null } });
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'customer.restored', subjectType: 'User', subjectId: userId, reasonCode: reason.slice(0, 100) }, tx);
      return { userId, status: next };
    });
  }

  // ───────────────────────── audit ─────────────────────────
  private auditWhere(f: { actorId?: string; action?: string; subjectType?: string; subjectId?: string; from?: string; to?: string }): Prisma.AuditLogWhereInput {
    const from = f.from ? new Date(f.from) : undefined;
    const to = f.to ? new Date(f.to) : undefined;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw new BadRequestException({ code: 'validation_failed', message: 'Invalid date' });
    return {
      ...(f.actorId ? { actorId: f.actorId } : {}), ...(f.action ? { action: { contains: f.action, mode: 'insensitive' } } : {}),
      ...(f.subjectType ? { subjectType: f.subjectType } : {}), ...(f.subjectId ? { subjectId: f.subjectId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
  }

  async auditLog(f: { actorId?: string; action?: string; subjectType?: string; subjectId?: string; from?: string; to?: string; limit?: number; cursor?: string }) {
    const limit = clampLimit(f.limit, 50, 200);
    const where = this.auditWhere(f);
    if (f.cursor) {
      const [at, id] = unb64(f.cursor).split('|');
      if (!at || !id || Number.isNaN(Date.parse(at))) throw new BadRequestException({ code: 'validation_failed', message: 'Invalid cursor' });
      where.AND = [{ OR: [{ createdAt: { lt: new Date(at) } }, { createdAt: new Date(at), id: { lt: id } }] }];
    }
    const rows = await this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const names = await this.actorNames(page.map((r) => r.actorId));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, at: r.createdAt, actorId: r.actorId, actorName: r.actorId ? names.get(r.actorId) ?? null : null, actorType: r.actorType, action: r.action, subjectType: r.subjectType, subjectId: r.subjectId, reasonCode: r.reasonCode, metadata: r.metadata, ip: r.ip })),
      nextCursor: rows.length > limit && last ? b64(`${last.createdAt.toISOString()}|${last.id}`) : null,
    };
  }

  private async actorNames(ids: (string | null)[]) {
    const real = [...new Set(ids.filter((x): x is string => !!x))];
    if (!real.length) return new Map<string, string>();
    const [c, s] = await Promise.all([this.prisma.customerProfile.findMany({ where: { userId: { in: real } }, select: { userId: true, fullName: true } }), this.prisma.staffProfile.findMany({ where: { userId: { in: real } }, select: { userId: true, fullName: true } })]);
    return new Map([...c, ...s].map((p) => [p.userId, p.fullName]));
  }

  /** Controlled export: capped, permission-gated, formula-safe, and itself audited. */
  async auditCsv(staffId: string, f: Parameters<OverviewService['auditWhere']>[0]) {
    const rows = await this.prisma.auditLog.findMany({ where: this.auditWhere(f), orderBy: { createdAt: 'desc' }, take: 5000 });
    const names = await this.actorNames(rows.map((r) => r.actorId));
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'audit.exported', metadata: { rows: rows.length } });
    return toCsv(['at', 'actorType', 'actorName', 'actorId', 'action', 'subjectType', 'subjectId', 'reasonCode', 'ip'], rows.map((r) => ({ at: r.createdAt, actorType: r.actorType, actorName: r.actorId ? names.get(r.actorId) : '', actorId: r.actorId, action: r.action, subjectType: r.subjectType, subjectId: r.subjectId, reasonCode: r.reasonCode, ip: r.ip })));
  }

  async securityEvents(limit?: number) {
    const rows = await this.prisma.securityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: clampLimit(limit, 50, 200) });
    return { items: rows.map((e) => ({ id: e.id, at: e.createdAt, kind: e.kind, severity: e.severity, userId: e.userId })) };
  }

  // ───────────────────────── reports ─────────────────────────
  private range(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new BadRequestException({ code: 'validation_failed', message: 'Invalid date range' });
    if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new BadRequestException({ code: 'range_too_large', message: 'Reports cover at most 366 days' });
    return { start, end };
  }

  async report(name: string, from?: string, to?: string): Promise<{ title: string; columns: string[]; rows: Record<string, unknown>[] }> {
    const { start, end } = this.range(from, to);
    if (name === 'transactions-daily') {
      const rows = await this.prisma.$queryRaw<{ day: Date; posted: bigint; failed: bigint; volume: bigint; fees: bigint }[]>`
        SELECT (date_trunc('day', "createdAt" AT TIME ZONE 'Asia/Colombo'))::date AS day,
          COUNT(*) FILTER (WHERE status='POSTED')::bigint AS posted, COUNT(*) FILTER (WHERE status='FAILED')::bigint AS failed,
          COALESCE(SUM("amountMinor") FILTER (WHERE status='POSTED'),0)::bigint AS volume, COALESCE(SUM("feeMinor") FILTER (WHERE status='POSTED'),0)::bigint AS fees
        FROM "PaymentInstruction" WHERE "createdAt" BETWEEN ${start} AND ${end} GROUP BY 1 ORDER BY 1`;
      return { title: 'Daily transactions', columns: ['day', 'posted', 'failed', 'volumeMinor', 'feesMinor'], rows: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), posted: Number(r.posted), failed: Number(r.failed), volumeMinor: num(r.volume), feesMinor: num(r.fees) })) };
    }
    if (name === 'customer-growth') {
      const rows = await this.prisma.$queryRaw<{ day: Date; registered: bigint }[]>`
        SELECT (date_trunc('day', "createdAt" AT TIME ZONE 'Asia/Colombo'))::date AS day, COUNT(*)::bigint AS registered
        FROM "User" WHERE type = 'CUSTOMER' AND "createdAt" BETWEEN ${start} AND ${end} GROUP BY 1 ORDER BY 1`;
      const accounts = await this.prisma.$queryRaw<{ day: Date; opened: bigint }[]>`
        SELECT (date_trunc('day', "openedAt" AT TIME ZONE 'Asia/Colombo'))::date AS day, COUNT(*)::bigint AS opened FROM "Account" WHERE "openedAt" BETWEEN ${start} AND ${end} GROUP BY 1`;
      const opened = new Map(accounts.map((a) => [a.day.toISOString().slice(0, 10), Number(a.opened)]));
      return { title: 'Customer and account growth', columns: ['day', 'customersRegistered', 'accountsOpened'], rows: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), customersRegistered: Number(r.registered), accountsOpened: opened.get(r.day.toISOString().slice(0, 10)) ?? 0 })) };
    }
    if (name === 'audit-activity') {
      const rows = await this.prisma.$queryRaw<{ day: Date; actorType: string; count: bigint }[]>`
        SELECT (date_trunc('day', "createdAt" AT TIME ZONE 'Asia/Colombo'))::date AS day, "actorType", COUNT(*)::bigint AS count
        FROM "AuditLog" WHERE "createdAt" BETWEEN ${start} AND ${end} GROUP BY 1, 2 ORDER BY 1, 2`;
      return { title: 'Audit activity', columns: ['day', 'actorType', 'events'], rows: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), actorType: r.actorType, events: Number(r.count) })) };
    }
    throw new NotFoundException({ code: 'not_found', message: 'Unknown report' });
  }

  async reportCsv(staffId: string, name: string, from?: string, to?: string) {
    const r = await this.report(name, from, to);
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'report.exported', subjectType: 'Report', subjectId: name, metadata: { rows: r.rows.length } });
    return toCsv(r.columns, r.rows);
  }
}
