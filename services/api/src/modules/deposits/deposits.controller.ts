import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { DepositsService } from './deposits.service';

const openSchema = z.object({
  fundingAccountId: z.string().uuid(),
  amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  termMonths: z.number().int().min(1).max(240),
  renewal: z.enum(['WITH_INTEREST', 'WITHOUT_INTEREST', 'PAYOUT']),
  pin: z.string().regex(/^(\d{4}|\d{6})$/),
}).strict();
const calcSchema = z.object({ amountMinor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER), termMonths: z.coerce.number().int().min(1).max(240) });
const closureSchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();
const decisionSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().max(500).optional() }).strict();
const rateSchema = z.object({ termMonths: z.number().int(), rateBps: z.number().int().min(0).max(5000), minAmountMinor: z.number().int().min(0).optional(), active: z.boolean().optional() }).strict();

@ApiTags('fixed-deposits')
@Controller({ path: 'fixed-deposits', version: '1' })
@CustomerOnly({ requireActive: true })
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get('rates') rates() { return this.deposits.rates(); }
  @Get('calculate') calculate(@Query(new ZodPipe(calcSchema)) q: z.infer<typeof calcSchema>) { return this.deposits.calculate(q.amountMinor, q.termMonths); }
  @Get() list(@CurrentUser() u: AuthUser) { return this.deposits.list(u.id); }
  @Get(':id') detail(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.deposits.detail(u.id, id); }

  /** Opening a deposit moves money: needs the PIN and an Idempotency-Key. Terms cannot be edited afterwards. */
  @Post()
  async open(@CurrentUser() u: AuthUser, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(openSchema)) b: z.infer<typeof openSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.deposits.open(u.id, key, b);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(r.replayed ? 200 : 201);
    return r.body;
  }

  @Post(':id/closure-request')
  closure(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(closureSchema)) b: z.infer<typeof closureSchema>) { return this.deposits.requestClosure(u.id, id, b.reason); }
}

@ApiTags('admin-fixed-deposits')
@Controller({ path: 'admin', version: '1' })
export class AdminDepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @StaffWith('deposits.manage') @Get('fixed-deposits') list(@Query('status') status?: string) { return this.deposits.adminList(status); }
  @StaffWith('deposits.manage') @Get('fixed-deposit-rates') rates() { return this.deposits.adminRates(); }
  @StaffWith('deposits.manage') @Get('fixed-deposit-closures') closures(@Query('status') status: string = 'PENDING') { return this.deposits.closureQueue(status); }

  @StaffWith('deposits.manage') @Post('fixed-deposit-closures/:id/decision')
  decide(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(decisionSchema)) b: z.infer<typeof decisionSchema>) { return this.deposits.decideClosure(s.id, id, b); }

  @StaffWith('settings.manage') @Put('fixed-deposit-rates')
  setRate(@CurrentUser() s: AuthUser, @Body(new ZodPipe(rateSchema)) b: z.infer<typeof rateSchema>) { return this.deposits.setRate(s.id, b); }
}
