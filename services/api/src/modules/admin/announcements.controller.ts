import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, StaffWith, type AuthUser } from '../auth/auth.decorators';

const schema = z.object({
  kind: z.enum(['OFFER', 'NOTICE']),
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(3).max(400),
}).strict();

/** Offers and bank notices sent to every active customer's in-app inbox. Customers can mute offers; notices are bank news. */
@ApiTags('admin')
@Controller({ path: 'admin/announcements', version: '1' })
export class AdminAnnouncementsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @StaffWith('settings.manage') @Post() @HttpCode(202)
  async send(@CurrentUser() s: AuthUser, @Body(new ZodPipe(schema)) b: z.infer<typeof schema>) {
    const customers = await this.prisma.user.findMany({ where: { type: 'CUSTOMER', status: 'ACTIVE' }, select: { id: true } });
    for (let i = 0; i < customers.length; i += 500) {
      await queueNotifications(this.prisma, 'announcement.sent', customers.slice(i, i + 500).map((c) => ({ userId: c.id, category: b.kind, title: b.title, body: b.body })));
    }
    await this.audit.record({ actorId: s.id, actorType: 'STAFF', action: 'announcement.sent', metadata: { kind: b.kind, title: b.title, recipients: customers.length } });
    return { recipients: customers.length };
  }

  @StaffWith('settings.manage') @Get()
  async recent() {
    const rows = await this.prisma.auditLog.findMany({ where: { action: 'announcement.sent' }, orderBy: { createdAt: 'desc' }, take: 20 });
    return { items: rows.map((r) => ({ at: r.createdAt, ...(r.metadata as Record<string, unknown>) })) };
  }
}
