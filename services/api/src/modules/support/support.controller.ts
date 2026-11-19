import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, CustomerOnly, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { DISPUTE_REASONS, FAQS, SupportService, TICKET_CATEGORIES } from './support.service';

const disputeSchema = z.object({ paymentId: z.string().uuid(), reasonCode: z.enum(DISPUTE_REASONS), description: z.string().trim().min(10).max(1000) }).strict();
const ticketSchema = z.object({ subject: z.string().trim().min(3).max(120), category: z.enum(TICKET_CATEGORIES), message: z.string().trim().min(5).max(2000) }).strict();
const replySchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
const staffReplySchema = z.object({ body: z.string().trim().min(1).max(2000), internal: z.boolean().optional() }).strict();
const statusSchema = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'CLOSED']) }).strict();
const disputeDecision = z.object({ decision: z.enum(['ACCEPT', 'REJECT']), resolution: z.string().trim().min(5).max(500), requestReversal: z.boolean().optional() }).strict();
const branchQuery = z.object({ city: z.string().max(60).optional(), type: z.string().max(10).optional(), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() });
const apptSchema = z.object({ branchId: z.string().uuid(), purpose: z.string().trim().min(3).max(200), preferredAt: z.string().datetime() }).strict();
const apptDecision = z.object({ decision: z.enum(['CONFIRM', 'CANCEL', 'COMPLETE']), confirmedFor: z.string().datetime().optional(), note: z.string().trim().max(300).optional() }).strict();
const branchSchema = z.object({ code: z.string().trim().regex(/^[A-Z0-9-]{3,20}$/), name: z.string().trim().min(2).max(80), city: z.string().trim().min(2).max(60), address: z.string().trim().min(3).max(160), type: z.enum(['BRANCH', 'ATM']), phone: z.string().trim().max(30).optional(), hours: z.string().trim().max(80).optional(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() }).strict();
const branchUpdate = branchSchema.omit({ code: true, type: true }).partial().extend({ active: z.boolean().optional() }).strict();

const upload = () => FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1 } }); // memory storage; size re-checked by the service
const download = (res: Response, f: { buffer: Buffer; fileName: string; contentType: string }) => {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(f.buffer);
};

@ApiTags('support')
@Controller({ version: '1' })
@CustomerOnly({ requireActive: true })
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // disputes
  @Post('disputes') dispute(@CurrentUser() u: AuthUser, @Body(new ZodPipe(disputeSchema)) b: z.infer<typeof disputeSchema>) { return this.support.createDispute(u.id, b); }
  @Get('disputes') disputes(@CurrentUser() u: AuthUser) { return this.support.myDisputes(u.id); }
  @Get('disputes/:id') disputeOne(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.support.myDispute(u.id, id); }

  // tickets
  @Get('support/faqs') faqs() { return { items: FAQS }; }
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('support/tickets')
  ticket(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ticketSchema)) b: z.infer<typeof ticketSchema>) { return this.support.createTicket(u.id, b); }
  @Get('support/tickets') tickets(@CurrentUser() u: AuthUser) { return this.support.myTickets(u.id); }
  @Get('support/tickets/:id') ticketOne(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.support.myTicket(u.id, id); }
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post('support/tickets/:id/messages')
  reply(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(replySchema)) b: z.infer<typeof replySchema>) { return this.support.customerReply(u.id, id, b.body); }
  @Post('support/tickets/:id/close') @HttpCode(204)
  async close(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.support.customerClose(u.id, id); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('support/tickets/:id/attachments') @UseInterceptors(upload())
  attach(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException({ code: 'file_required', message: 'Attach a file in the "file" field' });
    return this.support.addAttachment({ id: u.id, type: 'CUSTOMER' }, id, file);
  }
  @Get('support/tickets/:id/attachments/:aid')
  async getFile(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Param('aid', new ParseUUIDPipe()) aid: string, @Res() res: Response) { download(res, await this.support.downloadAttachment({ id: u.id, type: 'CUSTOMER' }, id, aid)); }

  // branches & appointments
  @Get('branches') branches(@Query(new ZodPipe(branchQuery)) q: z.infer<typeof branchQuery>) { return this.support.branches(q); }
  @Post('appointments') appointment(@CurrentUser() u: AuthUser, @Body(new ZodPipe(apptSchema)) b: z.infer<typeof apptSchema>) { return this.support.requestAppointment(u.id, b); }
  @Get('appointments') appointments(@CurrentUser() u: AuthUser) { return this.support.myAppointments(u.id); }
  @Post('appointments/:id/cancel') @HttpCode(204)
  async cancelAppt(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.support.cancelAppointment(u.id, id); }
}

@ApiTags('admin-support')
@Controller({ path: 'admin', version: '1' })
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @StaffWith('support.manage') @Get('disputes') disputes(@Query('status') status: string = 'OPEN') { return this.support.disputeQueue(status); }
  @StaffWith('support.manage') @Post('disputes/:id/review') startReview(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.support.startReview(s.id, id); }
  @StaffWith('support.manage') @Post('disputes/:id/decision')
  decide(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(disputeDecision)) b: z.infer<typeof disputeDecision>) { return this.support.decideDispute(s, id, b); }

  @StaffWith('support.manage') @Get('tickets') tickets(@CurrentUser() s: AuthUser, @Query('status') status: string = 'OPEN', @Query('mine') mine?: string) { return this.support.ticketQueue(status, mine === 'true' ? s.id : undefined); }
  @StaffWith('support.manage') @Get('tickets/:id') ticket(@Param('id', new ParseUUIDPipe()) id: string) { return this.support.staffTicket(id); }
  @StaffWith('support.manage') @Post('tickets/:id/messages')
  reply(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(staffReplySchema)) b: z.infer<typeof staffReplySchema>) { return this.support.staffReply(s.id, id, b); }
  @StaffWith('support.manage') @Post('tickets/:id/assign') assign(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.support.assignToMe(s.id, id); }
  @StaffWith('support.manage') @Put('tickets/:id/status')
  status(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(statusSchema)) b: z.infer<typeof statusSchema>) { return this.support.setStatus(s.id, id, b.status); }
  @StaffWith('support.manage') @Post('tickets/:id/attachments') @UseInterceptors(upload())
  attach(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException({ code: 'file_required', message: 'Attach a file in the "file" field' });
    return this.support.addAttachment({ id: s.id, type: 'STAFF' }, id, file);
  }
  @StaffWith('support.manage') @Get('tickets/:id/attachments/:aid')
  async getFile(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Param('aid', new ParseUUIDPipe()) aid: string, @Res() res: Response) { download(res, await this.support.downloadAttachment({ id: s.id, type: 'STAFF' }, id, aid)); }

  @StaffWith('support.manage') @Get('appointments') appointments(@Query('status') status: string = 'REQUESTED') { return this.support.appointmentQueue(status); }
  @StaffWith('support.manage') @Post('appointments/:id/decision')
  decideAppt(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(apptDecision)) b: z.infer<typeof apptDecision>) { return this.support.decideAppointment(s.id, id, b); }

  @StaffWith('branches.manage') @Get('branches') branches() { return this.support.adminBranches(); }
  @StaffWith('branches.manage') @Post('branches') create(@CurrentUser() s: AuthUser, @Body(new ZodPipe(branchSchema)) b: z.infer<typeof branchSchema>) { return this.support.createBranch(s.id, b); }
  @StaffWith('branches.manage') @Put('branches/:id')
  update(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(branchUpdate)) b: z.infer<typeof branchUpdate>) { return this.support.updateBranch(s.id, id, b); }
  @StaffWith('branches.manage') @Delete('branches/:id') @HttpCode(204)
  async deactivate(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { await this.support.updateBranch(s.id, id, { active: false }); }
}
