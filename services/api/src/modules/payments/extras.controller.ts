import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, type AuthUser } from '../auth/auth.decorators';
import { ExtrasService } from './extras.service';

const money = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const destination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('OWN'), accountId: z.string().uuid() }),
  z.object({ type: z.literal('BENEFICIARY'), beneficiaryId: z.string().uuid() }),
  z.object({ type: z.literal('ZENTRIX'), accountNumber: z.string().regex(/^\d{11}$/) }),
  z.object({ type: z.literal('INTERBANK'), bankCode: z.string().max(40), accountNumber: z.string().regex(/^\d{8,16}$/), holderName: z.string().trim().min(2).max(80) }),
  z.object({ type: z.literal('BILL'), billerCode: z.string().max(40), billRef: z.string().trim().min(3).max(40) }),
]);
const requestSchema = z.object({ receiveAccountId: z.string().uuid(), payerAccountNumber: z.string().regex(/^\d{11}$/), amountMinor: money, note: z.string().trim().max(60).optional() }).strict();
const paySchema = z.object({ sourceAccountId: z.string().uuid() }).strict();
const templateSchema = z.object({ name: z.string().trim().min(2).max(40), sourceAccountId: z.string().uuid().optional(), destination, amountMinor: money.optional(), note: z.string().trim().max(60).optional() }).strict();

@ApiTags('payment-extras')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class ExtrasController {
  constructor(private readonly extras: ExtrasService) {}

  @Post('payment-requests') createRequest(@CurrentUser() u: AuthUser, @Body(new ZodPipe(requestSchema)) b: z.infer<typeof requestSchema>) { return this.extras.createRequest(u.id, b); }
  @Get('payment-requests') requests(@CurrentUser() u: AuthUser) { return this.extras.listRequests(u.id); }

  /** Creates a draft payment (Idempotency-Key required). The payer then authorises it with their PIN via /payments/:id/authorize. */
  @Post('payment-requests/:id/pay')
  pay(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(paySchema)) b: z.infer<typeof paySchema>) {
    if (!key) throw new BadRequestException({ code: 'idempotency_key_required', message: 'Idempotency-Key header is required' });
    return this.extras.pay(u.id, id, key, b.sourceAccountId);
  }
  @Post('payment-requests/:id/decline') @HttpCode(204) async decline(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.extras.decline(u.id, id); }
  @Post('payment-requests/:id/cancel') @HttpCode(204) async cancel(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.extras.cancelRequest(u.id, id); }

  @Get('payment-templates') templates(@CurrentUser() u: AuthUser) { return this.extras.listTemplates(u.id); }
  @Post('payment-templates') createTemplate(@CurrentUser() u: AuthUser, @Body(new ZodPipe(templateSchema)) b: z.infer<typeof templateSchema>) { return this.extras.createTemplate(u.id, b); }
  @Delete('payment-templates/:id') @HttpCode(204) async deleteTemplate(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.extras.deleteTemplate(u.id, id); }

  @Get('subscriptions') subscriptions(@CurrentUser() u: AuthUser) { return this.extras.subscriptions(u.id); }
}
