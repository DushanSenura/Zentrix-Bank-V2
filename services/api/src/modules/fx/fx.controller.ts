import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { FxService } from './fx.service';

const quoteQuery = z.object({ fromAccountId: z.string().uuid(), toAccountId: z.string().uuid(), amountMinor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
const exchangeSchema = z.object({ token: z.string().min(20).max(1000), pin: z.string().regex(/^(\d{4}|\d{6})$/) }).strict();
const rateSchema = z.object({ midRate: z.number().positive().max(100_000) }).strict();

@ApiTags('fx')
@Controller({ path: 'fx', version: '1' })
@CustomerOnly({ requireActive: true })
export class FxController {
  constructor(private readonly fx: FxService) {}

  @Get('rates') rates() { return this.fx.rates(); }
  @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Get('quote') quote(@CurrentUser() u: AuthUser, @Query(new ZodPipe(quoteQuery)) q: z.infer<typeof quoteQuery>) { return this.fx.quote(u.id, q); }
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('exchange') @HttpCode(200)
  exchange(@CurrentUser() u: AuthUser, @Body(new ZodPipe(exchangeSchema)) b: z.infer<typeof exchangeSchema>) { return this.fx.exchange(u.id, b); }
}

@ApiTags('admin-fx')
@Controller({ path: 'admin/fx', version: '1' })
export class AdminFxController {
  constructor(private readonly fx: FxService) {}

  @StaffWith('settings.manage') @Get('rates') rates() { return this.fx.rates(); }
  @StaffWith('settings.manage') @Put('rates/:currency')
  set(@CurrentUser() s: AuthUser, @Param('currency') currency: string, @Body(new ZodPipe(rateSchema)) b: z.infer<typeof rateSchema>) { return this.fx.setRate(s.id, currency.toUpperCase(), b.midRate); }
}
