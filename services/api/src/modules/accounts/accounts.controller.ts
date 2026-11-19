import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { LedgerService } from '../ledger/ledger.service';
import { AccountsService } from './accounts.service';

const applySchema = z.object({ productCode: z.string().trim().min(2).max(40), nickname: z.string().trim().max(40).optional() });
const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(500).optional(),
  openingDepositMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED']), reasonCode: z.string().trim().min(3).max(100) });
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(200).optional() });

/** Customer endpoints. Active (KYC-approved) customers only. */
@ApiTags('accounts')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('accounts') list(@CurrentUser() u: AuthUser) { return this.accounts.list(u.id); }
  @Get('accounts/:id') detail(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.accounts.detail(u.id, id); }

  @Get('accounts/:id/transactions')
  transactions(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(pageSchema)) q: z.infer<typeof pageSchema>) {
    return this.accounts.transactions(u.id, id, q.limit, q.cursor);
  }

  @Get('account-products') products() { return this.accounts.products(); }
  @Get('account-applications') mine(@CurrentUser() u: AuthUser) { return this.accounts.myApplications(u.id); }

  @Post('account-applications')
  apply(@CurrentUser() u: AuthUser, @Body(new ZodPipe(applySchema)) b: z.infer<typeof applySchema>) {
    return this.accounts.apply(u.id, b.productCode, b.nickname);
  }
}

/** Staff endpoints. Every route names the permission it needs. */
@ApiTags('admin-accounts')
@Controller({ path: 'admin', version: '1' })
export class AdminAccountsController {
  constructor(private readonly accounts: AccountsService, private readonly ledger: LedgerService) {}

  @StaffWith('accounts.review') @Get('account-applications')
  queue(@Query('status') status: string = 'SUBMITTED') { return this.accounts.queue(status); }

  @StaffWith('accounts.review') @Post('account-applications/:id/decision')
  decide(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(decisionSchema)) b: z.infer<typeof decisionSchema>) {
    return this.accounts.decide(s.id, id, b);
  }

  @StaffWith('customers.read') @Get('accounts')
  search(@Query('q') q: string = '') { return this.accounts.search(q); }

  @StaffWith('accounts.manage') @Post('accounts/:id/status')
  status(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(statusSchema)) b: z.infer<typeof statusSchema>) {
    return this.accounts.setStatus(s.id, id, b.status, b.reasonCode);
  }

  @StaffWith('transactions.read') @Get('reconciliation')
  reconcile() { return this.ledger.reconcile(); }
}
