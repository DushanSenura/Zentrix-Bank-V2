import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { AiService } from '../ai/ai.service';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { OpsService } from '../risk/ops.service';
import { RiskService } from '../risk/risk.service';
import { AnalyticsService } from './analytics.service';

const monthQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() });
const trendQuery = z.object({ months: z.coerce.number().int().min(2).max(12).default(6) });
const askSchema = z.object({ question: z.string().trim().min(3).max(500), includeMyData: z.boolean().optional() }).strict();
const statusQuery = z.object({ status: z.string().max(20).default('OPEN') });
const resolveSchema = z.object({ status: z.enum(['CLEARED', 'ESCALATED']), note: z.string().trim().min(5).max(500) }).strict();

@ApiTags('analytics')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly ai: AiService) {}

  @Get('analytics/summary') summary(@CurrentUser() u: AuthUser, @Query(new ZodPipe(monthQuery)) q: z.infer<typeof monthQuery>) { return this.analytics.summary(u.id, q.month); }
  @Get('analytics/trend') trend(@CurrentUser() u: AuthUser, @Query(new ZodPipe(trendQuery)) q: z.infer<typeof trendQuery>) { return this.analytics.trend(u.id, q.months); }
  @Get('analytics/budget-suggestions') suggestions(@CurrentUser() u: AuthUser) { return this.analytics.suggestedBudgets(u.id); }
  @Get('analytics/recurring') recurring(@CurrentUser() u: AuthUser) { return this.analytics.recurring(u.id); }

  @Get('ai/status') status() { return this.ai.status(); }
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Get('ai/insights') insights(@CurrentUser() u: AuthUser) { return this.ai.insights(u.id); }
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post('ai/ask')
  ask(@CurrentUser() u: AuthUser, @Body(new ZodPipe(askSchema)) b: z.infer<typeof askSchema>) { return this.ai.ask(u.id, b.question, b.includeMyData ?? false); }
}

@ApiTags('admin-risk')
@Controller({ path: 'admin', version: '1' })
export class AdminRiskController {
  constructor(private readonly risk: RiskService, private readonly ops: OpsService) {}

  @StaffWith('risk.review') @Get('risk/alerts') alerts(@Query(new ZodPipe(statusQuery)) q: z.infer<typeof statusQuery>) { return this.risk.list(q.status); }
  @StaffWith('risk.review') @Get('risk/summary') summary() { return this.risk.summary(); }
  @StaffWith('risk.review') @Post('risk/alerts/:id/take') take(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.risk.take(s.id, id); }
  @StaffWith('risk.review') @Post('risk/alerts/:id/resolve')
  resolve(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(resolveSchema)) b: z.infer<typeof resolveSchema>) { return this.risk.resolve(s.id, id, b.status, b.note); }

  @StaffWith('reports.read') @Get('ops/health') health() { return this.ops.health(); }
}
