import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res, ServiceUnavailableException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV, type Env } from '../../config/env';
import { AccountsService } from '../accounts/accounts.service';
import { CurrentUser, CustomerOnly, Public, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { CardsService } from '../cards/cards.service';
import { DepositsService } from '../deposits/deposits.service';
import { LoansService } from '../loans/loans.service';
import { BeneficiariesService } from './beneficiaries.service';
import { BILLERS, encodeQr, SIMULATED_BANKS } from './catalog';
import { PaymentsService } from './payments.service';

const money = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const destination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('OWN'), accountId: z.string().uuid() }),
  z.object({ type: z.literal('BENEFICIARY'), beneficiaryId: z.string().uuid() }),
  z.object({ type: z.literal('ZENTRIX'), accountNumber: z.string().regex(/^\d{11}$/) }),
  z.object({ type: z.literal('INTERBANK'), bankCode: z.string().max(40), accountNumber: z.string().regex(/^\d{8,16}$/), holderName: z.string().trim().min(2).max(80) }),
  z.object({ type: z.literal('BILL'), billerCode: z.string().max(40), billRef: z.string().trim().min(3).max(40) }),
  z.object({ type: z.literal('QR'), payload: z.string().max(100) }),
  z.object({ type: z.literal('LOAN'), loanId: z.string().uuid() }),
]);
// .strict(): a client-supplied "fee", "balance" or "status" is REJECTED, not silently ignored.
const createSchema = z.object({
  sourceAccountId: z.string().uuid(),
  destination,
  amountMinor: money,
  note: z.string().trim().max(60).optional(),
  scheduledFor: z.string().datetime().optional(),
}).strict();
const authorizeSchema = z.object({ pin: z.string().regex(/^(\d{4}|\d{6})$/) }).strict();
const recurringSchema = z.object({
  sourceAccountId: z.string().uuid(), destination, amountMinor: money, frequency: z.enum(['WEEKLY', 'MONTHLY']),
  startDate: z.string().datetime(), endDate: z.string().datetime().optional(), note: z.string().trim().max(60).optional(), pin: z.string().regex(/^(\d{4}|\d{6})$/),
}).strict();
const beneficiarySchema = z.object({ bankCode: z.string().max(40), accountNumber: z.string().regex(/^\d{8,16}$/), holderName: z.string().trim().min(2).max(80).optional(), nickname: z.string().trim().max(40).optional() }).strict();
const beneficiaryUpdate = z.object({ nickname: z.string().trim().max(40).nullable().optional(), favorite: z.boolean().optional() }).strict();

@ApiTags('payments')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService, private readonly beneficiaries: BeneficiariesService, private readonly accounts: AccountsService) {}

  /** Step 1 (review). Requires an Idempotency-Key header. Creates a draft; no money moves. */
  @Post('payments')
  async create(@CurrentUser() u: AuthUser, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>, @Res({ passthrough: true }) res: Response) {
    if (!key) throw new BadRequestException({ code: 'idempotency_key_required', message: 'Idempotency-Key header is required' });
    const r = await this.payments.create(u.id, key, b);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(r.replayed ? 200 : 201);
    return r.body;
  }

  @Get('payments') list(@CurrentUser() u: AuthUser, @Query('scheduled') scheduled?: string) { return this.payments.list(u.id, scheduled === 'true'); }
  @Get('payments/by-key/:key') byKey(@CurrentUser() u: AuthUser, @Param('key') key: string) { return this.payments.getByKey(u.id, key.slice(0, 64)); }
  @Get('payments/:id') get(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.payments.get(u.id, id); }

  /** Step 2: server-verified PIN, then atomic execution. Safe to repeat: a finished payment just returns its receipt. */
  @Post('payments/:id/authorize') @HttpCode(200)
  authorize(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(authorizeSchema)) b: z.infer<typeof authorizeSchema>) {
    return this.payments.authorize(u.id, id, b.pin);
  }

  @Post('payments/:id/cancel') @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.payments.cancel(u.id, id); }

  // standing instructions
  @Get('scheduled-payments') recurring(@CurrentUser() u: AuthUser) { return this.payments.listRecurring(u.id); }
  @Post('scheduled-payments')
  createRecurring(@CurrentUser() u: AuthUser, @Body(new ZodPipe(recurringSchema)) b: z.infer<typeof recurringSchema>) { return this.payments.createRecurring(u.id, b); }
  @Delete('scheduled-payments/:id') @HttpCode(204)
  async cancelRecurring(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.payments.cancelRecurring(u.id, id); }

  // beneficiaries
  @Get('beneficiaries') listBeneficiaries(@CurrentUser() u: AuthUser) { return this.beneficiaries.list(u.id); }
  @Post('beneficiaries') addBeneficiary(@CurrentUser() u: AuthUser, @Body(new ZodPipe(beneficiarySchema)) b: z.infer<typeof beneficiarySchema>) { return this.beneficiaries.add(u.id, b); }
  @Put('beneficiaries/:id') updateBeneficiary(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(beneficiaryUpdate)) b: z.infer<typeof beneficiaryUpdate>) { return this.beneficiaries.update(u.id, id, b); }
  @Delete('beneficiaries/:id') @HttpCode(204)
  async removeBeneficiary(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.beneficiaries.remove(u.id, id); }

  // catalogues & QR
  @Get('billers') billers() { return { items: BILLERS, banks: SIMULATED_BANKS }; }

  /** "My QR": identity only (account number). Ownership is enforced. */
  @Get('payments-qr/:accountId')
  async myQr(@CurrentUser() u: AuthUser, @Param('accountId', new ParseUUIDPipe()) accountId: string) {
    const acc = await this.accounts.getOwned(u.id, accountId);
    return { payload: encodeQr(acc.accountNumber), accountNumberMasked: `*******${acc.accountNumber.slice(-4)}` };
  }
}

@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
@CustomerOnly()
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.notification.count({ where: { userId: u.id, readAt: null } }),
    ]);
    return { unread, items: rows.map((n) => ({ id: n.id, category: n.category, title: n.title, body: n.body, read: !!n.readAt, createdAt: n.createdAt })) };
  }

  @Post('read-all') @HttpCode(204)
  async readAll(@CurrentUser() u: AuthUser) { await this.prisma.notification.updateMany({ where: { userId: u.id, readAt: null }, data: { readAt: new Date() } }); }

  @Post(':id/read') @HttpCode(204)
  async read(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.prisma.notification.updateMany({ where: { id, userId: u.id, readAt: null }, data: { readAt: new Date() } }); }
}

@ApiTags('admin-payments')
@Controller({ path: 'admin/payments', version: '1' })
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @StaffWith('transactions.read') @Get()
  list(@Query('status') status?: string) { return this.payments.adminList(status); }
}

/** Called by the worker on a schedule. Authenticated by a shared secret, never by a user session. */
@ApiTags('internal')
@Controller({ path: 'internal/jobs', version: '1' })
export class InternalJobsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly cards: CardsService,
    private readonly deposits: DepositsService,
    private readonly loans: LoansService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public() @Post('run-due') @HttpCode(200)
  async runDue(@Headers('x-internal-token') token?: string) {
    const expected = this.env.INTERNAL_JOB_TOKEN;
    if (!expected) throw new ServiceUnavailableException({ code: 'jobs_disabled', message: 'Internal jobs are not configured' });
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException({ code: 'unauthenticated', message: 'Invalid token' });
    // Each job is independent: one failing must never stop the others. Failures are counted, not hidden.
    const safe = async <T>(f: () => Promise<T>, fallback: T, errors: string[], name: string): Promise<T> => {
      try { return await f(); } catch { errors.push(name); return fallback; }
    };
    const errors: string[] = [];
    const now = new Date();
    const pay = await safe(() => this.payments.runDue(now), { expired: 0, recurringCreated: 0, executed: 0, failed: 0 }, errors, 'payments');
    const cardsReady = await safe(() => this.cards.runDue(now), 0, errors, 'cards');
    const dep = await safe(() => this.deposits.runDue(now), { matured: 0, renewed: 0, failed: 0 }, errors, 'deposits');
    const loan = await safe(() => this.loans.runDue(now), { overdue: 0, reminders: 0 }, errors, 'loans');
    return { ...pay, cardsReady, depositsMatured: dep.matured, depositsRenewed: dep.renewed, depositsFailed: dep.failed, loansOverdue: loan.overdue, loanReminders: loan.reminders, errors };
  }
}
