import { Body, ConflictException, Controller, Get, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV, type Env } from '../../config/env';
import { decrypt, encrypt, sha256 } from '../../security/crypto';
import { newTotpSecret, totpUri, verifyTotp } from '../../security/totp';
import { CurrentUser, CustomerOnly, type AuthUser } from './auth.decorators';
import { PinService } from './pin.service';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODES = 8;
const pin = z.string().regex(/^(\d{4}|\d{6})$/);
const code = z.string().regex(/^\d{6}$/);
const setupSchema = z.object({ pin }).strict();
const enableSchema = z.object({ code }).strict();
const proveSchema = z.object({ pin, code: z.string().min(6).max(14) }).strict(); // an authenticator code or a recovery code

/** Recovery codes look like ABCDE-FGHJK. Normalised so spaces, dashes and case do not matter. */
export const normaliseRecovery = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
const newRecoveryCode = () => { const r = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); return `${r.slice(0, 5)}-${r.slice(5)}`; };

/**
 * Optional two-step sign-in for customers (authenticator app). Staff always have it; this is the customer-side opt-in.
 * Turning it on needs the PIN and a working code; turning it off needs the PIN and a code (or a recovery code).
 */
@ApiTags('security')
@Controller({ path: 'security/2fa', version: '1' })
@CustomerOnly()
export class TwoFactorController {
  private readonly key: Buffer;
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pins: PinService, @Inject(ENV) env: Env) {
    this.key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
  }

  @Get()
  async status(@CurrentUser() u: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { mfaEnabledAt: true } });
    return { enabled: !!user.mfaEnabledAt, enabledAt: user.mfaEnabledAt, recoveryCodesLeft: user.mfaEnabledAt ? await this.prisma.recoveryCode.count({ where: { userId: u.id, usedAt: null } }) : 0 };
  }

  /** Starts enrolment: returns the secret ONCE for the authenticator app. Nothing changes at sign-in until a code is confirmed. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('setup') @HttpCode(200)
  async setup(@CurrentUser() u: AuthUser, @Body(new ZodPipe(setupSchema)) b: z.infer<typeof setupSchema>) {
    await this.pins.verify(u.id, b.pin);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (user.mfaEnabledAt) throw new ConflictException({ code: 'already_enabled', message: 'Two-step sign-in is already on' });
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: u.id }, data: { mfaSecretEnc: encrypt(secret, this.key) } });
    return { secret, otpauthUri: totpUri(secret, user.username) };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('enable') @HttpCode(200)
  async enable(@CurrentUser() u: AuthUser, @Body(new ZodPipe(enableSchema)) b: z.infer<typeof enableSchema>) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (user.mfaEnabledAt) throw new ConflictException({ code: 'already_enabled', message: 'Two-step sign-in is already on' });
    if (!user.mfaSecretEnc) throw new ConflictException({ code: 'not_started', message: 'Start setup first' });
    if (!verifyTotp(decrypt(user.mfaSecretEnc, this.key), b.code)) throw new UnauthorizedException({ code: 'invalid_code', message: 'That code is not right. Check the time on your phone and try again.' });
    const codes = Array.from({ length: CODES }, newRecoveryCode);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { mfaEnabledAt: new Date() } });
      await tx.recoveryCode.deleteMany({ where: { userId: u.id } });
      await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId: u.id, codeHash: sha256(normaliseRecovery(c)) })) });
      await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.2fa_enabled', subjectType: 'User', subjectId: u.id }, tx);
      await queueNotifications(tx, 'security.2fa_enabled', [{ userId: u.id, category: 'SECURITY', title: 'Two-step sign-in is on', body: 'You will need a code from your authenticator app each time you sign in. Keep your recovery codes safe.' }]);
    });
    return { recoveryCodes: codes, note: 'Each recovery code works once. They are shown only now.' };
  }

  private async prove(userId: string, input: { pin: string; code: string }) {
    await this.pins.verify(userId, input.pin);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabledAt || !user.mfaSecretEnc) throw new ConflictException({ code: 'not_enabled', message: 'Two-step sign-in is not on' });
    if (/^\d{6}$/.test(input.code) ? verifyTotp(decrypt(user.mfaSecretEnc, this.key), input.code) : await this.useRecovery(userId, input.code)) return;
    throw new UnauthorizedException({ code: 'invalid_code', message: 'That code is not right' });
  }

  private async useRecovery(userId: string, raw: string): Promise<boolean> {
    const r = await this.prisma.recoveryCode.updateMany({ where: { userId, codeHash: sha256(normaliseRecovery(raw)), usedAt: null }, data: { usedAt: new Date() } });
    return r.count === 1;
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('disable') @HttpCode(204)
  async disable(@CurrentUser() u: AuthUser, @Body(new ZodPipe(proveSchema)) b: z.infer<typeof proveSchema>) {
    await this.prove(u.id, b);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { mfaEnabledAt: null, mfaSecretEnc: null } });
      await tx.recoveryCode.deleteMany({ where: { userId: u.id } });
      await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.2fa_disabled', subjectType: 'User', subjectId: u.id }, tx);
      await queueNotifications(tx, 'security.2fa_disabled', [{ userId: u.id, category: 'SECURITY', title: 'Two-step sign-in is off', body: 'Two-step sign-in was turned off for your account. If this was not you, change your password now.' }]);
    });
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('recovery-codes') @HttpCode(200)
  async regenerate(@CurrentUser() u: AuthUser, @Body(new ZodPipe(proveSchema)) b: z.infer<typeof proveSchema>) {
    await this.prove(u.id, b);
    const codes = Array.from({ length: CODES }, newRecoveryCode);
    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId: u.id } });
      await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId: u.id, codeHash: sha256(normaliseRecovery(c)) })) });
      await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'security.recovery_codes_regenerated', subjectType: 'User', subjectId: u.id }, tx);
    });
    return { recoveryCodes: codes, note: 'Your earlier recovery codes no longer work.' };
  }
}
