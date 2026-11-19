import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { hashSecret, passwordProblem, pinProblem, verifySecret } from '../../security/password';
import { CurrentUser, CustomerOnly, type AuthUser } from './auth.decorators';

const MAX_PIN_FAILS = 5;

const changePasswordSchema = z.object({ current: z.string().max(128), next: z.string().max(128) });
const changePinSchema = z.object({ currentPin: z.string().max(6), newPin: z.string().max(6) });
const verifyPinSchema = z.object({ pin: z.string().max(6) });
const deviceSchema = z.object({ fingerprint: z.string().trim().min(8).max(128), label: z.string().trim().max(60).optional() });

/** Customer security centre: sessions, devices, login history, password and PIN changes. All scoped to the caller. */
@ApiTags('security')
@Controller({ path: 'security', version: '1' })
@CustomerOnly()
export class SecurityController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('sessions')
  async sessions(@CurrentUser() u: AuthUser) {
    const rows = await this.prisma.session.findMany({
      where: { userId: u.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((s) => ({ id: s.id, createdAt: s.createdAt, userAgent: s.userAgent, ip: s.ip, current: s.id === u.sessionId })) };
  }

  /** Scoped by userId: another customer's session id is indistinguishable from a missing one. */
  @Delete('sessions/:id') @HttpCode(204)
  async revoke(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.prisma.session.updateMany({ where: { id, userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Session not found' });
    await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.session_revoked', subjectType: 'Session', subjectId: id });
  }

  @Post('sessions/revoke-others') @HttpCode(204)
  async revokeOthers(@CurrentUser() u: AuthUser) {
    await this.prisma.session.updateMany({ where: { userId: u.id, revokedAt: null, id: { not: u.sessionId } }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.other_sessions_revoked' });
  }

  @Get('login-history')
  async history(@CurrentUser() u: AuthUser) {
    const rows = await this.prisma.loginHistory.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 25 });
    return { items: rows.map((h) => ({ at: h.createdAt, success: h.success, ip: h.ip, userAgent: h.userAgent })) };
  }

  @Put('password') @HttpCode(204)
  async changePassword(@CurrentUser() u: AuthUser, @Body(new ZodPipe(changePasswordSchema)) b: z.infer<typeof changePasswordSchema>) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { customer: true } });
    if (!(await verifySecret(user.passwordHash, b.current))) {
      await this.audit.securityEvent('PASSWORD_CHANGE_BAD_CURRENT', u.id);
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Your current password is incorrect' });
    }
    const problem = passwordProblem(b.next, [user.username, ...(user.customer?.fullName.split(/\s+/) ?? [])]);
    if (problem) throw new BadRequestException({ code: 'weak_password', message: problem, fields: { next: problem } });
    if (await verifySecret(user.passwordHash, b.next)) throw new BadRequestException({ code: 'weak_password', message: 'Choose a different password', fields: { next: 'Choose a different password' } });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { passwordHash: await hashSecret(b.next) } });
      await tx.session.updateMany({ where: { userId: u.id, revokedAt: null, id: { not: u.sessionId } }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.password_changed' }, tx);
      await tx.outboxEvent.create({ data: { topic: 'security.password_changed', payload: { userId: u.id } } });
    });
  }

  /** Verifies the app PIN server-side. 5 consecutive failures sign the customer out everywhere. */
  @Post('pin/verify') @HttpCode(204)
  async verifyPin(@CurrentUser() u: AuthUser, @Body(new ZodPipe(verifyPinSchema)) b: z.infer<typeof verifyPinSchema>) {
    await this.checkPin(u, b.pin);
  }

  @Put('pin') @HttpCode(204)
  async changePin(@CurrentUser() u: AuthUser, @Body(new ZodPipe(changePinSchema)) b: z.infer<typeof changePinSchema>) {
    await this.checkPin(u, b.currentPin);
    const problem = pinProblem(b.newPin);
    if (problem) throw new BadRequestException({ code: 'weak_pin', message: problem, fields: { newPin: problem } });
    await this.prisma.user.update({ where: { id: u.id }, data: { pinHash: await hashSecret(b.newPin), pinSetAt: new Date() } });
    await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.pin_changed' });
  }

  private async checkPin(u: AuthUser, pin: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!user.pinHash) throw new ConflictException({ code: 'no_pin', message: 'Set an app PIN first' });
    if (await verifySecret(user.pinHash, pin)) {
      if (user.pinFailedAttempts) await this.prisma.user.update({ where: { id: u.id }, data: { pinFailedAttempts: 0 } });
      return;
    }
    const failed = user.pinFailedAttempts + 1;
    if (failed >= MAX_PIN_FAILS) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: u.id }, data: { pinFailedAttempts: 0 } }),
        this.prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
      await this.audit.securityEvent('PIN_LOCKOUT_SIGNED_OUT', u.id, undefined, 'HIGH');
    } else {
      await this.prisma.user.update({ where: { id: u.id }, data: { pinFailedAttempts: failed } });
    }
    throw new UnauthorizedException({ code: 'invalid_pin', message: failed >= MAX_PIN_FAILS ? 'Too many attempts. Please sign in again.' : 'Incorrect PIN' });
  }

  // ───────── trusted devices ("remember this device") ─────────
  @Get('devices')
  async devices(@CurrentUser() u: AuthUser) {
    const rows = await this.prisma.trustedDevice.findMany({ where: { userId: u.id, revokedAt: null }, orderBy: { trustedAt: 'desc' } });
    return { items: rows.map((d) => ({ id: d.id, label: d.label, trustedAt: d.trustedAt, lastSeenAt: d.lastSeenAt })) };
  }

  @Post('devices')
  async trust(@CurrentUser() u: AuthUser, @Body(new ZodPipe(deviceSchema)) b: z.infer<typeof deviceSchema>, @Req() _r: Request) {
    const d = await this.prisma.trustedDevice.upsert({
      where: { userId_fingerprint: { userId: u.id, fingerprint: b.fingerprint } },
      update: { revokedAt: null, label: b.label, lastSeenAt: new Date() },
      create: { userId: u.id, fingerprint: b.fingerprint, label: b.label, lastSeenAt: new Date() },
    });
    await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.device_trusted', subjectType: 'TrustedDevice', subjectId: d.id });
    return { id: d.id };
  }

  @Delete('devices/:id') @HttpCode(204)
  async untrust(@CurrentUser() u: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.prisma.trustedDevice.updateMany({ where: { id, userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Device not found' });
  }
}
