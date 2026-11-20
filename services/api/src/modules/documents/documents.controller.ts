import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, type AuthUser } from '../auth/auth.decorators';
import { BeneficiariesService } from '../payments/beneficiaries.service';
import { DocumentsService } from './documents.service';
import { LANGS } from './pdf';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const statementQuery = z.object({ from: day.optional(), to: day.optional(), format: z.enum(['pdf', 'csv']).default('pdf'), lang: z.enum(LANGS as [string, ...string[]]).default('en') });
const langQuery = z.object({ lang: z.enum(LANGS as [string, ...string[]]).default('en') });
const searchQuery = z.object({
  accountId: z.string().uuid().optional(), category: z.string().max(60).optional(), q: z.string().max(100).optional(), from: day.optional(), to: day.optional(),
  minMinor: z.coerce.number().int().min(0).optional(), maxMinor: z.coerce.number().int().min(0).optional(), direction: z.enum(['IN', 'OUT']).optional(), kind: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional(),
});

const send = (res: Response, f: { buffer: Buffer; filename: string; contentType: string }) => {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.setHeader('Cache-Control', 'no-store'); // financial documents are never cached by browsers or proxies
  res.send(f.buffer);
};

@ApiTags('documents')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class DocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly beneficiaries: BeneficiariesService) {}

  /** One search box for the app: this customer's saved recipients and recent transactions. (Features and settings are matched on the device.) */
  @Get('search') async globalSearch(@CurrentUser() u: AuthUser, @Query(new ZodPipe(z.object({ q: z.string().trim().min(2).max(60) }))) q: { q: string }) {
    const term = q.q.toLowerCase();
    const [ben, tx] = await Promise.all([this.beneficiaries.list(u.id), this.docs.search(u.id, { q: q.q, limit: 8 })]);
    return { beneficiaries: ben.items.filter((b) => JSON.stringify(b).toLowerCase().includes(term)).slice(0, 8), transactions: tx.items };
  }

  @Get('transactions') search(@CurrentUser() u: AuthUser, @Query(new ZodPipe(searchQuery)) q: z.infer<typeof searchQuery>) { return this.docs.search(u.id, q); }

  @Get('transactions/:id') detail(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.docs.detail(u.id, id); }
  @Get('payments/:id/repeat') repeat(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.docs.repeatDraft(u.id, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Get('accounts/:id/statement')
  async statement(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(statementQuery)) q: z.infer<typeof statementQuery>, @Res() res: Response) {
    send(res, await this.docs.statement(u.id, id, { from: q.from, to: q.to, format: q.format, lang: q.lang as 'en' }));
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Get('accounts/:id/certificate')
  async certificate(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(langQuery)) q: z.infer<typeof langQuery>, @Res() res: Response) { send(res, await this.docs.accountCertificate(u.id, id, q.lang as 'en')); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Get('payments/:id/receipt')
  async receipt(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(langQuery)) q: z.infer<typeof langQuery>, @Res() res: Response) { send(res, await this.docs.receipt(u.id, id, q.lang as 'en')); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Get('fixed-deposits/:id/certificate')
  async fd(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(langQuery)) q: z.infer<typeof langQuery>, @Res() res: Response) { send(res, await this.docs.depositCertificate(u.id, id, q.lang as 'en')); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Get('loans/:id/schedule-pdf')
  async loan(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(langQuery)) q: z.infer<typeof langQuery>, @Res() res: Response) { send(res, await this.docs.loanSchedule(u.id, id, q.lang as 'en')); }
}
