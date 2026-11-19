import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { verifySecret } from '../../security/password';

export const MAX_PIN_FAILS = 5;

/**
 * Server-side PIN verification (step-up authorisation). Shared by app unlock, PIN change and payments so the
 * lockout rule is identical everywhere: 5 consecutive failures revoke every session and record a HIGH event.
 */
@Injectable()
export class PinService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async verify(userId: string, pin: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.pinHash) throw new ConflictException({ code: 'no_pin', message: 'Set an app PIN first' });
    if (await verifySecret(user.pinHash, pin)) {
      if (user.pinFailedAttempts) await this.prisma.user.update({ where: { id: userId }, data: { pinFailedAttempts: 0 } });
      return;
    }
    // Atomic increment so concurrent guesses cannot slip under the limit.
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { pinFailedAttempts: { increment: 1 } } });
    const failed = updated.pinFailedAttempts;
    if (failed >= MAX_PIN_FAILS) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { pinFailedAttempts: 0 } }),
        this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
      await this.audit.securityEvent('PIN_LOCKOUT_SIGNED_OUT', userId, undefined, 'HIGH');
    }
    throw new UnauthorizedException({ code: 'invalid_pin', message: failed >= MAX_PIN_FAILS ? 'Too many attempts. Please sign in again.' : 'Incorrect PIN' });
  }
}
