import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

/** Operational dashboard numbers for staff: is the platform keeping up with its background work? */
@Injectable()
export class OpsService {
  constructor(private readonly prisma: PrismaService) {}

  async health(now = new Date()) {
    const day = new Date(now.getTime() - 86_400_000);
    const [backlog, oldest, failing, notes24, dueUnrun, stuckDrafts, openTickets, openDisputes, risk] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
      this.prisma.outboxEvent.findFirst({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.outboxEvent.count({ where: { publishedAt: null, lastError: { not: null } } }),
      this.prisma.notification.count({ where: { createdAt: { gte: day } } }),
      this.prisma.scheduledPayment.count({ where: { active: true, nextRunAt: { lt: new Date(now.getTime() - 15 * 60_000) } } }),
      this.prisma.paymentInstruction.count({ where: { status: { in: ['AUTHORIZED', 'PENDING_PROCESSING'] }, createdAt: { lt: new Date(now.getTime() - 3_600_000) } } }),
      this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      this.prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      this.prisma.riskAlert.groupBy({ by: ['severity'], where: { status: { in: ['OPEN', 'INVESTIGATING'] } }, _count: true }),
    ]);
    const lagSeconds = oldest ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000) : 0;
    const warnings: string[] = [];
    if (lagSeconds > 300) warnings.push(`Notifications are ${Math.round(lagSeconds / 60)} minutes behind. Is the worker running?`);
    if (failing > 0) warnings.push(`${failing} notification event(s) have failed delivery attempts.`);
    if (dueUnrun > 0) warnings.push(`${dueUnrun} scheduled payment(s) are more than 15 minutes overdue.`);
    return {
      checkedAt: now.toISOString(), status: warnings.length ? 'ATTENTION' : 'OK', warnings,
      outbox: { pending: backlog, oldestPendingSeconds: lagSeconds, failing }, notificationsLast24h: notes24,
      scheduledPaymentsOverdue: dueUnrun, unfinishedPaymentsOverAnHour: stuckDrafts,
      queues: { openTickets, openDisputes }, openRiskAlertsBySeverity: Object.fromEntries(risk.map((r) => [r.severity, r._count])),
    };
  }
}
