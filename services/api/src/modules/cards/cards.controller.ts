import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { CardsService } from './cards.service';

const pin = z.string().regex(/^(\d{4}|\d{6})$/);
const requestSchema = z.object({
  kind: z.enum(['DEBIT', 'VIRTUAL', 'CREDIT']),
  accountId: z.string().uuid(),
  pin,
  collectionBranchId: z.string().uuid().optional(),
  application: z.object({ monthlyIncomeMinor: z.number().int().min(1), employment: z.string().trim().min(2).max(80), requestedLimitMinor: z.number().int().min(1) }).strict().optional(),
}).strict();
const activateSchema = z.object({ pin, cardPin: z.string().regex(/^\d{4}$/) }).strict();
const freezeSchema = z.object({ frozen: z.boolean() }).strict();
const controlsSchema = z.object({ dailyLimitMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), onlineEnabled: z.boolean().optional(), internationalEnabled: z.boolean().optional(), contactlessEnabled: z.boolean().optional(), pin: pin.optional() }).strict();
const lostSchema = z.object({ pin }).strict();
const cardPinSchema = z.object({ currentPin: z.string().regex(/^\d{4}$/), newPin: z.string().regex(/^\d{4}$/) }).strict();
const decisionSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().max(500).optional(), creditLimitMinor: z.number().int().min(1).optional() }).strict();
const blockSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

@ApiTags('cards')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get('cards') list(@CurrentUser() u: AuthUser) { return this.cards.list(u.id); }
  @Get('cards/:id') detail(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.cards.detail(u.id, id); }
  @Get('cards/:id/history') history(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.cards.history(u.id, id); }

  @Post('cards') request(@CurrentUser() u: AuthUser, @Body(new ZodPipe(requestSchema)) b: z.infer<typeof requestSchema>) { return this.cards.request(u.id, b); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('cards/:id/activate') @HttpCode(200)
  activate(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(activateSchema)) b: z.infer<typeof activateSchema>) { return this.cards.activate(u.id, id, b.pin, b.cardPin); }

  @Post('cards/:id/freeze') @HttpCode(200)
  freeze(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(freezeSchema)) b: z.infer<typeof freezeSchema>) { return this.cards.freeze(u.id, id, b.frozen); }

  @Put('cards/:id/controls')
  controls(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(controlsSchema)) b: z.infer<typeof controlsSchema>) { return this.cards.setControls(u.id, id, b); }

  @Post('cards/:id/report-lost') @HttpCode(200)
  lost(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(lostSchema)) b: z.infer<typeof lostSchema>) { return this.cards.reportLost(u.id, id, b.pin); }

  @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Put('cards/:id/pin') @HttpCode(204)
  async cardPin(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(cardPinSchema)) b: z.infer<typeof cardPinSchema>) { await this.cards.changeCardPin(u.id, id, b.currentPin, b.newPin); }
}

@ApiTags('admin-cards')
@Controller({ path: 'admin/cards', version: '1' })
export class AdminCardsController {
  constructor(private readonly cards: CardsService) {}

  @StaffWith('cards.review') @Get() queue(@Query('status') status: string = 'PENDING_APPROVAL') { return this.cards.queue(status); }

  @StaffWith('cards.review') @Post(':id/decision')
  decide(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(decisionSchema)) b: z.infer<typeof decisionSchema>) { return this.cards.decide(s.id, id, b); }

  @StaffWith('cards.review') @Post(':id/block')
  block(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(blockSchema)) b: z.infer<typeof blockSchema>) { return this.cards.block(s.id, id, b.reason); }
}
