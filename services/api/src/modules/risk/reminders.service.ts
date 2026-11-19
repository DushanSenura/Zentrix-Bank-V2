import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Reminder notifications. Each reminder is written once: ReminderLog(kind, subject, dueKey) is unique and is created in the
 * same transaction as the outbox event, so re-running the job (or two workers racing) never sends a duplicate.
 */
@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  private async once(kind: string, subjectId: string, dueKey: string, notify: Parameters<typeof queueNotifications>[2], topic: string): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.reminderLog.create({ data: { kind, subjectId, dueKey } });
        await queueNotifications(tx, topic, notify);
      });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  async runDue(now = new Date()): Promise<{ fdMaturity: number; scheduledPayments: number }> {
    let fdMaturity = 0, scheduledPayments = 0;
    const fds = await this.prisma.fixedDeposit.findMany({ where: { status: 'ACTIVE', maturityDate: { gt: now, lte: new Date(now.getTime() + 7 * DAY) } }, take: 500 });
    for (const fd of fds) {
      const days = Math.max(1, Math.ceil((fd.maturityDate.getTime() - now.getTime()) / DAY));
      if (await this.once('fd.maturity', fd.id, day(fd.maturityDate), [{ userId: fd.customerId, category: 'ACCOUNT', title: 'Fixed deposit maturing soon', body: `Your fixed deposit ${fd.reference} (${lkr(fd.principalMinor)}) matures in ${days} day${days === 1 ? '' : 's'}, on ${day(fd.maturityDate)}.` }], 'fd.maturity_reminder')) fdMaturity++;
    }
    const sp = await this.prisma.scheduledPayment.findMany({ where: { active: true, nextRunAt: { gt: now, lte: new Date(now.getTime() + DAY) } }, take: 500 });
    for (const s of sp) {
      if (await this.once('scheduled.payment', s.id, s.nextRunAt.toISOString(), [{ userId: s.customerId, category: 'TRANSACTION', title: 'Scheduled payment tomorrow', body: `A payment of ${lkr(s.amountMinor)} is scheduled for ${day(s.nextRunAt)}. Make sure the account has enough money.` }], 'scheduled.reminder')) scheduledPayments++;
    }
    return { fdMaturity, scheduledPayments };
  }
}
