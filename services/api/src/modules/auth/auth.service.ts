import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ENV, type Env } from '../../config/env';
import { decrypt, randomToken, safeEqualHex, sha256 } from '../../security/crypto';
import { DUMMY_HASH_PROMISE, hashSecret, passwordProblem, verifySecret } from '../../security/password';
import { verifyTotp } from '../../security/totp';
import { normaliseRecovery } from './two-factor.controller';
import { TokenService } from './token.service';

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;
const GENERIC = { code: 'invalid_credentials', message: 'Invalid credentials' };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get key() {
    return Buffer.from(this.env.DATA_ENCRYPTION_KEY, 'base64');
  }

  async register(input: { fullName: string; username: string; email: string; phone?: string; password: string }, ctx: ClientContext) {
    const problem = passwordProblem(input.password, [input.username, ...input.fullName.split(/\s+/)]);
    if (problem) this.bad(problem);
    const username = input.username.toLowerCase();
    const email = input.email.toLowerCase();
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } });
    if (existing) throw new ConflictException({ code: 'already_registered', message: 'That username or email is already in use' });

    const passwordHash = await hashSecret(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      let customerNumber = '';
      for (let i = 0; i < 5; i++) {
        customerNumber = `ZB${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
        if (!(await tx.customerProfile.findUnique({ where: { customerNumber } }))) break;
      }
      const u = await tx.user.create({
        data: {
          type: 'CUSTOMER', // public registration can only ever create customers
          username,
          email,
          phone: input.phone,
          passwordHash,
          customer: { create: { customerNumber, fullName: input.fullName.trim() } },
        },
      });
      await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'customer.registered', subjectType: 'User', subjectId: u.id, ip: ctx.ip }, tx);
      return u;
    });
    return this.openSession(user.id, 'CUSTOMER', ctx);
  }

  private bad(message: string): never {
    throw new BadRequestException({ code: 'weak_password', message, fields: { password: message } });
  }

  async login(input: { identifier: string; password: string; mfaCode?: string; recoveryCode?: string }, ctx: ClientContext): Promise<TokenPair & { userType: string }> {
    const id = input.identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: id }, { email: id }, { customer: { customerNumber: input.identifier.trim().toUpperCase() } }] },
    });

    const fail = async (reason: string): Promise<never> => {
      await this.prisma.loginHistory.create({
        data: { userId: user?.id, identifier: id.slice(0, 3) + '***', success: false, ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 200) },
      });
      if (user) await this.audit.securityEvent('LOGIN_FAILED', user.id, { reason });
      throw new UnauthorizedException(GENERIC);
    };

    // Always run one Argon2 verification so unknown users and wrong passwords take similar time.
    const ok = await verifySecret(user?.passwordHash ?? (await DUMMY_HASH_PROMISE), input.password);
    if (!user) return fail('unknown_user');
    if (user.lockedUntil && user.lockedUntil > new Date()) return fail('locked');
    if (!ok) {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      if (lock) await this.audit.securityEvent('ACCOUNT_LOCKED', user.id, { minutes: LOCK_MINUTES });
      return fail('bad_password');
    }
    if (user.status === 'SUSPENDED' || user.status === 'CLOSED') return fail('account_unavailable');

    if (user.type === 'STAFF') {
      // MFA is mandatory for staff. A staff account without enrolled MFA cannot sign in.
      if (!user.mfaSecretEnc) return fail('mfa_not_enrolled');
      if (!input.mfaCode) throw new UnauthorizedException({ code: 'mfa_required', message: 'Enter your authenticator code' });
      if (!verifyTotp(decrypt(user.mfaSecretEnc, this.key), input.mfaCode)) return fail('bad_mfa');
    }

    if (user.type === 'CUSTOMER' && user.mfaEnabledAt && user.mfaSecretEnc) {
      // Optional two-step sign-in, switched on by the customer. A recovery code stands in for the authenticator and works once.
      if (!input.mfaCode && !input.recoveryCode) throw new UnauthorizedException({ code: 'mfa_required', message: 'Enter your authenticator code' });
      const good = input.mfaCode
        ? verifyTotp(decrypt(user.mfaSecretEnc, this.key), input.mfaCode)
        : (await this.prisma.recoveryCode.updateMany({ where: { userId: user.id, codeHash: sha256(normaliseRecovery(input.recoveryCode!)), usedAt: null }, data: { usedAt: new Date() } })).count === 1;
      if (!good) return fail('bad_mfa');
      if (input.recoveryCode) await this.audit.securityEvent('RECOVERY_CODE_USED', user.id, undefined, 'MEDIUM');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    await this.prisma.loginHistory.create({
      data: { userId: user.id, identifier: id.slice(0, 3) + '***', success: true, ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 200) },
    });
    await this.audit.record({ actorId: user.id, actorType: user.type, action: 'auth.login', ip: ctx.ip });
    return { ...(await this.openSession(user.id, user.type, ctx)), userType: user.type };
  }

  private async openSession(userId: string, type: 'CUSTOMER' | 'STAFF', ctx: ClientContext): Promise<TokenPair> {
    const ttlMs = type === 'STAFF' ? this.env.STAFF_SESSION_HOURS * 3_600_000 : this.env.CUSTOMER_SESSION_DAYS * 86_400_000;
    const secret = randomToken();
    const session = await this.prisma.session.create({
      data: { userId, refreshTokenHash: sha256(secret), ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 200), expiresAt: new Date(Date.now() + ttlMs) },
    });
    return {
      accessToken: await this.tokens.sign(userId, session.id),
      refreshToken: `${session.id}.${secret}`,
      expiresInSeconds: this.env.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /** Rotating refresh. Presenting an already-rotated token revokes the whole session (theft signal). */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const dot = refreshToken.indexOf('.');
    const sid = dot > 0 ? refreshToken.slice(0, dot) : '';
    const secret = dot > 0 ? refreshToken.slice(dot + 1) : '';
    const invalid = new UnauthorizedException({ code: 'invalid_refresh', message: 'Please sign in again' });
    if (!/^[0-9a-f-]{36}$/.test(sid) || !secret) throw invalid;

    const session = await this.prisma.session.findUnique({ where: { id: sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw invalid;
    if (!safeEqualHex(session.refreshTokenHash, sha256(secret))) {
      await this.prisma.session.update({ where: { id: sid }, data: { revokedAt: new Date() } });
      await this.audit.securityEvent('REFRESH_TOKEN_REUSE', session.userId, { sessionId: sid }, 'HIGH');
      throw invalid;
    }
    const next = randomToken();
    // Atomic compare-and-swap: of two concurrent identical refreshes only one wins.
    const swapped = await this.prisma.session.updateMany({
      where: { id: sid, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: sha256(next) },
    });
    if (swapped.count !== 1) throw invalid;
    return { accessToken: await this.tokens.sign(session.userId, sid), refreshToken: `${sid}.${next}`, expiresInSeconds: this.env.ACCESS_TOKEN_TTL_SECONDS };
  }

  async logout(sessionId: string, userId: string) {
    await this.prisma.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Always succeeds from the caller's view (never reveals whether the account exists). */
  async requestPasswordReset(identifier: string): Promise<void> {
    const id = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({ where: { OR: [{ username: id }, { email: id }], type: 'CUSTOMER', status: { not: 'CLOSED' } } });
    if (!user) return;
    const token = randomToken();
    await this.prisma.$transaction(async (tx) => {
      await tx.authenticationChallenge.updateMany({ where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null }, data: { consumedAt: new Date() } });
      await tx.authenticationChallenge.create({
        data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000) },
      });
      // Delivered by the worker (email/SMS provider arrives in Phase 8). The raw token is only placed in the
      // outbox in development so local testers can complete the flow; it is never logged.
      await tx.outboxEvent.create({
        data: {
          topic: 'auth.password_reset_requested',
          payload: { userId: user.id, ...(this.env.APP_ENV === 'development' ? { devToken: token } : {}) },
        },
      });
    });
    await this.audit.securityEvent('PASSWORD_RESET_REQUESTED', user.id, undefined, 'INFO');
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const ch = await this.prisma.authenticationChallenge.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { include: { customer: true } } } });
    const bad = this.badToken();
    if (!ch || ch.purpose !== 'PASSWORD_RESET' || ch.consumedAt || ch.expiresAt < new Date()) throw bad;
    const problem = passwordProblem(newPassword, [ch.user.username, ...(ch.user.customer?.fullName.split(/\s+/) ?? [])]);
    if (problem) this.bad(problem);
    const passwordHash = await hashSecret(newPassword);
    await this.prisma.$transaction(async (tx) => {
      // Single-use: the conditional update fails for a concurrent second use.
      const used = await tx.authenticationChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (used.count !== 1) throw bad;
      await tx.user.update({ where: { id: ch.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null } });
      await tx.session.updateMany({ where: { userId: ch.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: ch.userId, actorType: 'CUSTOMER', action: 'auth.password_reset', subjectType: 'User', subjectId: ch.userId }, tx);
    });
  }

  private badToken() {
    return new UnauthorizedException({ code: 'invalid_reset_token', message: 'This reset link is invalid or has expired' });
  }
}
