import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, type AuthUser } from '../auth/auth.decorators';
import { SavingsService } from './savings.service';

const money = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const goalSchema = z.object({ name: z.string().trim().min(2).max(60), targetMinor: money, targetDate: z.string().datetime().optional() }).strict();
const moveSchema = z.object({ accountId: z.string().uuid(), amountMinor: money, pin: z.string().regex(/^(\d{4}|\d{6})$/) }).strict();
const budgetSchema = z.object({ limitMinor: money }).strict();

@ApiTags('savings')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class SavingsController {
  constructor(private readonly savings: SavingsService) {}

  @Get('savings/goals') list(@CurrentUser() u: AuthUser) { return this.savings.list(u.id); }
  @Post('savings/goals') create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(goalSchema)) b: z.infer<typeof goalSchema>) { return this.savings.create(u.id, b); }

  @Post('savings/goals/:id/contribute')
  async contribute(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(moveSchema)) b: z.infer<typeof moveSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.savings.move(u.id, key, id, 'CONTRIBUTE', b);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(r.replayed ? 200 : 201);
    return r.body;
  }

  @Post('savings/goals/:id/withdraw')
  async withdraw(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(moveSchema)) b: z.infer<typeof moveSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.savings.move(u.id, key, id, 'WITHDRAW', b);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(r.replayed ? 200 : 201);
    return r.body;
  }

  @Delete('savings/goals/:id') @HttpCode(204)
  async close(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.savings.close(u.id, id); }

  @Get('budgets') budgets(@CurrentUser() u: AuthUser) { return this.savings.budgets(u.id); }
  @Put('budgets/:category') set(@CurrentUser() u: AuthUser, @Param('category') category: string, @Body(new ZodPipe(budgetSchema)) b: z.infer<typeof budgetSchema>) { return this.savings.setBudget(u.id, decodeURIComponent(category), b.limitMinor); }
  @Delete('budgets/:category') @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('category') category: string) { await this.savings.deleteBudget(u.id, decodeURIComponent(category)); }
}
