import { BadRequestException, Body, Controller, ConflictException, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV, type Env } from '../../config/env';
import { encrypt } from '../../security/crypto';
import { hashSecret, pinProblem } from '../../security/password';
import { CurrentUser, CustomerOnly, type AuthUser } from '../auth/auth.decorators';

const pinSchema = z.object({ pin: z.string().max(6) });
const kycSchema = z.object({
  nationalId: z.string().trim().min(5).max(20).regex(/^[A-Za-z0-9]+$/),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  address: z.object({ line1: z.string().trim().min(3).max(120), city: z.string().trim().min(2).max(60), postalCode: z.string().trim().max(12) }),
});

@ApiTags('me')
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Both customers and staff may read their own profile. No sensitive fields are returned. */
  @Get()
  async me(@CurrentUser() u: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      include: { customer: true, staff: true },
    });
    return {
      id: user.id,
      type: user.type,
      status: user.status,
      username: user.username,
      email: user.email,
      fullName: user.customer?.fullName ?? user.staff?.fullName,
      customerNumber: user.customer?.customerNumber,
      kycStatus: user.customer?.kycStatus,
      kycNote: user.customer?.kycStatus === 'MORE_INFO_REQUESTED' || user.customer?.kycStatus === 'REJECTED' ? user.customer.kycNote : undefined,
      hasPin: !!user.pinHash,
      permissions: u.type === 'STAFF' ? [...u.permissions].sort() : undefined,
    };
  }

  @CustomerOnly() @HttpCode(204) @Put('pin')
  async setPin(@CurrentUser() u: AuthUser, @Body(new ZodPipe(pinSchema)) b: z.infer<typeof pinSchema>) {
    const problem = pinProblem(b.pin);
    if (problem) throw new BadRequestException({ code: 'weak_pin', message: problem, fields: { pin: problem } });
    await this.prisma.user.update({ where: { id: u.id }, data: { pinHash: await hashSecret(b.pin), pinSetAt: new Date() } });
    await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'customer.pin_set' });
  }

  @CustomerOnly() @Post('kyc')
  async submitKyc(@CurrentUser() u: AuthUser, @Body(new ZodPipe(kycSchema)) b: z.infer<typeof kycSchema>) {
    const dob = new Date(`${b.dateOfBirth}T00:00:00Z`);
    const age = (Date.now() - dob.getTime()) / (365.25 * 86_400_000);
    if (Number.isNaN(dob.getTime()) || age < 18 || age > 120)
      throw new BadRequestException({ code: 'validation_failed', message: 'You must be at least 18', fields: { dateOfBirth: 'You must be at least 18' } });

    const key = Buffer.from(this.env.DATA_ENCRYPTION_KEY, 'base64');
    // Conditional update makes the state transition atomic: only NOT_SUBMITTED / MORE_INFO_REQUESTED may submit.
    const r = await this.prisma.customerProfile.updateMany({
      where: { userId: u.id, kycStatus: { in: ['NOT_SUBMITTED', 'MORE_INFO_REQUESTED'] } },
      data: { nationalIdEnc: encrypt(b.nationalId, key), dateOfBirth: dob, address: b.address, kycStatus: 'SUBMITTED', kycNote: null },
    });
    if (r.count !== 1) throw new ConflictException({ code: 'kyc_not_editable', message: 'Your verification is already submitted or decided' });
    await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'kyc.submitted', subjectType: 'User', subjectId: u.id });
    return { kycStatus: 'SUBMITTED' };
  }
}
