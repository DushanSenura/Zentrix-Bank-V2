import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, Public, StaffWith, type AuthUser } from '../auth/auth.decorators';
import { LedgerOpsService } from './ledger-ops.service';
import { OverviewService } from './overview.service';
import { MaintenanceService, SettingsService } from './settings.service';
import { StaffService } from './staff.service';

const reason = z.string().trim().min(3).max(300);
const customersQuery = z.object({ q: z.string().max(100).optional(), status: z.string().max(30).optional(), kyc: z.string().max(30).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional() });
const reasonBody = z.object({ reason }).strict();
const auditQuery = z.object({ actorId: z.string().uuid().optional(), action: z.string().max(80).optional(), subjectType: z.string().max(60).optional(), subjectId: z.string().max(80).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(200).optional() });
const reportQuery = z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() });
const settingSchema = z.object({ value: z.union([z.number(), z.boolean(), z.string()]) }).strict();
const provisionSchema = z.object({
  fullName: z.string().trim().min(2).max(120), username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/), email: z.string().trim().email().max(200), roleKeys: z.array(z.string().max(40)).min(1).max(5),
}).strict();
const rolesSchema = z.object({ roleKeys: z.array(z.string().max(40)).min(1).max(5) }).strict();
const permsSchema = z.object({ permissionKeys: z.array(z.string().max(60)).max(50) }).strict();
const setupSchema = z.object({ token: z.string().min(20).max(200), password: z.string().max(128) }).strict();
const reversalSchema = z.object({ paymentId: z.string().uuid(), reason }).strict();
const adjustmentSchema = z.object({ accountId: z.string().uuid(), direction: z.enum(['CREDIT', 'DEBIT']), amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), reason }).strict();
const decisionSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().max(500).optional() }).strict();

const csv = (res: Response, name: string, body: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  return body;
};

@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminOverviewController {
  constructor(private readonly overview: OverviewService) {}

  /** Any signed-in staff member; the response contains only the sections their permissions allow. */
  @StaffWith() @Get('dashboard') dashboard(@CurrentUser() s: AuthUser) { return this.overview.dashboard(s.permissions); }

  @StaffWith('customers.read') @Get('customers') customers(@Query(new ZodPipe(customersQuery)) q: z.infer<typeof customersQuery>) { return this.overview.customers(q); }
  @StaffWith('customers.read') @Get('customers/:id') customer(@Param('id', new ParseUUIDPipe()) id: string) { return this.overview.customerDetail(id); }
  @StaffWith('customers.suspend') @Post('customers/:id/suspend')
  suspend(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(reasonBody)) b: z.infer<typeof reasonBody>) { return this.overview.suspend(s.id, id, b.reason); }
  @StaffWith('customers.suspend') @Post('customers/:id/restore')
  restore(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(reasonBody)) b: z.infer<typeof reasonBody>) { return this.overview.restore(s.id, id, b.reason); }

  @StaffWith('audit.read') @Get('audit') audit(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) { return this.overview.auditLog(q); }
  @StaffWith('audit.read') @Get('audit-export')
  async auditExport(@CurrentUser() s: AuthUser, @Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>, @Res({ passthrough: true }) res: Response) { return csv(res, 'audit.csv', await this.overview.auditCsv(s.id, q)); }
  @StaffWith('audit.read') @Get('security-events') events(@Query('limit') limit?: string) { return this.overview.securityEvents(limit ? Number(limit) : undefined); }

  @StaffWith('reports.read') @Get('reports/:name') report(@Param('name') name: string, @Query(new ZodPipe(reportQuery)) q: z.infer<typeof reportQuery>) { return this.overview.report(name, q.from, q.to); }
  @StaffWith('reports.read') @Get('reports/:name/export')
  async reportExport(@CurrentUser() s: AuthUser, @Param('name') name: string, @Query(new ZodPipe(reportQuery)) q: z.infer<typeof reportQuery>, @Res({ passthrough: true }) res: Response) { return csv(res, `${name.replace(/[^a-z-]/g, '')}.csv`, await this.overview.reportCsv(s.id, name, q.from, q.to)); }
}

@ApiTags('admin-settings')
@Controller({ path: 'admin/settings', version: '1' })
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}
  @StaffWith('settings.manage') @Get() list() { return this.settings.list(); }
  @StaffWith('settings.manage') @Put(':key')
  set(@CurrentUser() s: AuthUser, @Param('key') key: string, @Body(new ZodPipe(settingSchema)) b: z.infer<typeof settingSchema>) { return this.settings.set(s.id, key, b.value); }
}

@ApiTags('system')
@Controller({ path: 'system', version: '1' })
export class SystemController {
  constructor(private readonly maintenance: MaintenanceService) {}
  /** Public: lets the apps show a maintenance notice before (or instead of) signing in. */
  @Public() @Get('status') async status() { const m = await this.maintenance.status(); return { maintenance: m.enabled, message: m.enabled ? m.message : null }; }
}

@ApiTags('admin-staff')
@Controller({ path: 'admin', version: '1' })
export class AdminStaffController {
  constructor(private readonly staff: StaffService) {}

  @StaffWith('staff.manage') @Get('staff') list() { return this.staff.list(); }
  @StaffWith('staff.manage') @Post('staff') provision(@CurrentUser() s: AuthUser, @Body(new ZodPipe(provisionSchema)) b: z.infer<typeof provisionSchema>) { return this.staff.provision(s, b); }
  @StaffWith('staff.manage') @Put('staff/:id/roles')
  setRoles(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(rolesSchema)) b: z.infer<typeof rolesSchema>) { return this.staff.setRoles(s, id, b.roleKeys); }
  @StaffWith('staff.manage') @Post('staff/:id/deactivate') @HttpCode(200)
  deactivate(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(reasonBody)) b: z.infer<typeof reasonBody>) { return this.staff.setActive(s, id, false, b.reason); }
  @StaffWith('staff.manage') @Post('staff/:id/activate') @HttpCode(200)
  activate(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(reasonBody)) b: z.infer<typeof reasonBody>) { return this.staff.setActive(s, id, true, b.reason); }
  @StaffWith('staff.manage') @Post('staff/:id/revoke-sessions') @HttpCode(200)
  revoke(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.staff.revokeSessions(s, id); }
  @StaffWith('staff.manage') @Get('staff/:id/login-history') history(@Param('id', new ParseUUIDPipe()) id: string) { return this.staff.loginHistory(id); }

  @StaffWith('staff.manage') @Get('roles') roles() { return this.staff.roles(); }
  @StaffWith('roles.manage') @Put('roles/:key/permissions')
  setPerms(@CurrentUser() s: AuthUser, @Param('key') key: string, @Body(new ZodPipe(permsSchema)) b: z.infer<typeof permsSchema>) { return this.staff.setRolePermissions(s, key, b.permissionKeys); }
}

@ApiTags('staff-setup')
@Controller({ path: 'auth', version: '1' })
export class StaffSetupController {
  constructor(private readonly staff: StaffService) {}
  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('staff-setup') @HttpCode(200)
  setup(@Body(new ZodPipe(setupSchema)) b: z.infer<typeof setupSchema>) { return this.staff.completeSetup(b.token, b.password); }
}

@ApiTags('admin-ledger')
@Controller({ path: 'admin/ledger', version: '1' })
export class AdminLedgerOpsController {
  constructor(private readonly ops: LedgerOpsService) {}

  @StaffWith('transactions.read') @Get('reconciliation') reconciliation() { return this.ops.reconciliation(); }
  @StaffWith('transactions.adjust') @Post('reversals') request(@CurrentUser() s: AuthUser, @Body(new ZodPipe(reversalSchema)) b: z.infer<typeof reversalSchema>) { return this.ops.requestReversal(s.id, b.paymentId, b.reason); }
  @StaffWith('transactions.adjust') @Post('adjustments') adjust(@CurrentUser() s: AuthUser, @Body(new ZodPipe(adjustmentSchema)) b: z.infer<typeof adjustmentSchema>) { return this.ops.requestAdjustment(s.id, b); }
  @StaffWith('transactions.adjust') @Get('approvals') list(@Query('status') status: string = 'PENDING') { return this.ops.list(status); }
  @StaffWith('transactions.adjust') @Post('approvals/:id/decision')
  decide(@CurrentUser() s: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(decisionSchema)) b: z.infer<typeof decisionSchema>) { return this.ops.decide(s.id, id, b); }
}
