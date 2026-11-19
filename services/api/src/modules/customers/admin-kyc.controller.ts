import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV, type Env } from '../../config/env';
import { decrypt, maskTail } from '../../security/crypto';
import { CurrentUser, StaffWith, type AuthUser } from '../auth/auth.decorators';

const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_INFO']),
  reason: z.string().trim().max(500).optional(),
});

@ApiTags('admin-kyc')
@Controller({ path: 'admin/kyc', version: '1' })
export class AdminKycController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @StaffWith('kyc.review') @Get()
  async queue(@Query('status') status: string = 'SUBMITTED') {
    const s = (Object.values(KycStatus) as string[]).includes(status) ? (status as KycStatus) : 'SUBMITTED';
    const rows = await this.prisma.customerProfile.findMany({
      where: { kycStatus: s },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: { select: { username: true, email: true, status: true } } },
    });
    const key = Buffer.from(this.env.DATA_ENCRYPTION_KEY, 'base64');
    return {
      items: rows.map((r) => ({
        userId: r.userId,
        customerNumber: r.customerNumber,
        fullName: r.fullName,
        email: r.user.email,
        kycStatus: r.kycStatus,
        dateOfBirth: r.dateOfBirth?.toISOString().slice(0, 10),
        nationalIdMasked: r.nationalIdEnc ? maskTail(decrypt(r.nationalIdEnc, key)) : null, // full ID is never returned
        address: r.address,
      })),
    };
  }

  @StaffWith('kyc.review') @Post(':userId/decision')
  async decide(
    @CurrentUser() staff: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodPipe(decisionSchema)) b: z.infer<typeof decisionSchema>,
  ) {
    if (b.decision !== 'APPROVE' && !b.reason)
      throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { reason: 'Required' } });
    const next: KycStatus = b.decision === 'APPROVE' ? 'APPROVED' : b.decision === 'REJECT' ? 'REJECTED' : 'MORE_INFO_REQUESTED';

    await this.prisma.$transaction(async (tx) => {
      const r = await tx.customerProfile.updateMany({
        where: { userId, kycStatus: 'SUBMITTED' },
        data: { kycStatus: next, kycReviewedById: staff.id, kycReviewedAt: new Date(), kycNote: b.reason ?? null },
      });
      if (r.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This submission is not awaiting review' });
      if (next === 'APPROVED') await tx.user.update({ where: { id: userId, type: 'CUSTOMER', status: 'PENDING_VERIFICATION' }, data: { status: 'ACTIVE' } });
      await this.audit.record(
        { actorId: staff.id, actorType: 'STAFF', action: `kyc.${b.decision.toLowerCase()}`, subjectType: 'User', subjectId: userId, reasonCode: b.reason?.slice(0, 100) },
        tx,
      );
      await tx.outboxEvent.create({ data: { topic: 'customer.kyc_decided', payload: { userId, status: next } } });
    });
    return { userId, kycStatus: next };
  }
}
