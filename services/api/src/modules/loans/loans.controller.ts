import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { LoansService } from './loans.service';

const calcSchema = z.object({
  productCode: z.string().max(40), amountMinor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER), termMonths: z.coerce.number().int().min(1).max(360),
  monthlyIncomeMinor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
const applySchema = z.object({
  productCode: z.string().max(40), amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), termMonths: z.number().int().min(1).max(360),
  monthlyIncomeMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), employment: z.string().trim().min(2).max(80), purpose: z.string().trim().max(200).optional(),
  disbursementAccountId: z.string().uuid(), consent: z.literal(true),
}).strict();
const recommendSchema = z.object({ approvedAmountMinor: z.number().int().min(1).optional(), termMonths: z.number().int().min(1).max(360).optional(), rateBps: z.number().int().min(0).max(5000).optional(), conditions: z.string().trim().max(500).optional() }).strict();
const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const decisionSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().max(500).optional() }).strict();

@ApiTags('loans')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Get('loan-products') products() { return this.loans.products(); }
  @Get('loans/calculate') calculate(@Query(new ZodPipe(calcSchema)) q: z.infer<typeof calcSchema>) { return this.loans.calculate(q.productCode, q.amountMinor, q.termMonths, q.monthlyIncomeMinor); }

  /** Submitting an application never approves anything and never moves money. */
  @Post('loan-applications') apply(@CurrentUser() u: AuthUser, @Body(new ZodPipe(applySchema)) b: z.infer<typeof applySchema>) { return this.loans.apply(u.id, b); }
  @Get('loan-applications') applications(@CurrentUser() u: AuthUser) { return this.loans.myApplications(u.id); }

  @Get('loans') list(@CurrentUser() u: AuthUser) { return this.loans.listLoans(u.id); }
  @Get('loans/:id') detail(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.loans.loanDetail(u.id, id); }
  @Get('loans/:id/settlement') settlement(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.loans.settlementQuote(u.id, id); }
}

@ApiTags('admin-loans')
@Controller({ path: 'admin', version: '1' })
export class AdminLoansController {
  constructor(private readonly loans: LoansService) {}

  @StaffWith('loans.review') @Get('loan-applications') queue(@Query('status') status: string = 'SUBMITTED') { return this.loans.queue(status); }

  @StaffWith('loans.review') @Post('loan-applications/:id/recommend')
  recommend(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(recommendSchema)) b: z.infer<typeof recommendSchema>) { return this.loans.recommend(s.id, id, b); }

  @StaffWith('loans.review') @Post('loan-applications/:id/reject')
  reject(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(rejectSchema)) b: z.infer<typeof rejectSchema>) { return this.loans.rejectApplication(s.id, id, b.reason); }

  @StaffWith('loans.approve') @Get('loan-approvals') approvals(@Query('status') status: string = 'PENDING') { return this.loans.approvals(status); }

  @StaffWith('loans.approve') @Post('loan-approvals/:id/decision')
  decide(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(decisionSchema)) b: z.infer<typeof decisionSchema>) { return this.loans.decideApproval(s.id, id, b); }

  @StaffWith('loans.review') @Get('loans') loans_(@Query('status') status?: string) { return this.loans.adminLoans(status); }
}
