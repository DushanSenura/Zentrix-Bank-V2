import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PaymentKind } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { withIdempotency } from '../../common/idempotency';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { PinService } from '../auth/pin.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';
import { BILLERS } from '../payments/catalog';
import { startOfBankingDay } from '../payments/policy.service';

/** Spending category of a posted payment, used by budgets. Own-account moves are not spending and have no category. */
export function paymentCategory(kind: PaymentKind, destination: unknown): string | null {
  switch (kind) {
    case 'OWN_TRANSFER': return null;
    case 'BILL_PAYMENT': return (destination as { category?: string }).category ?? 'Other';
    case 'LOAN_INSTALMENT': return 'Loan repayments';
    default: return 'Transfers';
  }
}

export const BUDGET_CATEGORIES = [...new Set([...BILLERS.map((b) => b.category), 'Transfers', 'Loan repayments'])];

/** First day of the current banking month (Sri Lanka time) as a UTC instant, and its YYYY-MM label. */
export function bankingMonth(now: Date): { start: Date; label: string } {
  const local = new Date(now.getTime() + 5.5 * 3_600_000);
  const start = startOfBankingDay(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 12)));
  return { start, label: `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}` };
}

@Injectable()
export class SavingsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService, private readonly pins: PinService) {}

  // ───────────────────────── goals ─────────────────────────
  private view(g: { id: string; name: string; targetMinor: bigint; targetDate: Date | null; status: string; createdAt: Date }, saved: bigint) {
    const pct = g.targetMinor > 0n ? Number((saved * 100n) / g.targetMinor) : 0;
    return { id: g.id, name: g.name, targetMinor: num(g.targetMinor), savedMinor: num(saved), progressPercent: Math.min(100, pct), targetDate: g.targetDate?.toISOString() ?? null, status: g.status };
  }

  async list(customerId: string) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { customerId, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'asc' } });
    const balances = new Map((await this.prisma.ledgerAccount.findMany({ where: { id: { in: goals.map((g) => g.ledgerAccountId) } } })).map((l) => [l.id, l.balanceMinor]));
    const items = goals.map((g) => this.view(g, balances.get(g.ledgerAccountId) ?? 0n));
    return { items, totalSavedMinor: items.reduce((s, i) => s + i.savedMinor, 0) };
  }

  async create(customerId: string, i: { name: string; targetMinor: number; targetDate?: string }) {
    const date = i.targetDate ? new Date(i.targetDate) : null;
    if (date && (Number.isNaN(date.getTime()) || date.getTime() < Date.now())) throw new BadRequestException({ code: 'validation_failed', message: 'Choose a target date in the future', fields: { targetDate: 'Invalid date' } });
    if ((await this.prisma.savingsGoal.count({ where: { customerId, status: { not: 'CLOSED' } } })) >= 20) throw new ConflictException({ code: 'goal_limit', message: 'You can have at most 20 active goals' });
    const g = await this.prisma.$transaction(async (tx) => {
      const id = crypto.randomUUID();
      const la = await tx.ledgerAccount.create({ data: { code: `GOAL-${id}`, name: `Savings goal ${id}`, type: 'LIABILITY', currency: 'LKR' } });
      const goal = await tx.savingsGoal.create({ data: { id, customerId, name: i.name, targetMinor: BigInt(i.targetMinor), targetDate: date, ledgerAccountId: la.id } });
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'savings.goal_created', subjectType: 'SavingsGoal', subjectId: id }, tx);
      return goal;
    });
    return this.view(g, 0n);
  }

  private async owned(customerId: string, id: string) {
    const g = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!g || g.customerId !== customerId) {
      if (g) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'SavingsGoal', id });
      throw new NotFoundException({ code: 'not_found', message: 'Goal not found' });
    }
    return g;
  }

  /** Moves money between the customer's account and the goal's own ledger account. PIN + Idempotency-Key. */
  async move(customerId: string, key: string | undefined, goalId: string, direction: 'CONTRIBUTE' | 'WITHDRAW', i: { accountId: string; amountMinor: number; pin: string }) {
    const { result, replayed } = await withIdempotency(this.prisma, {
      userId: customerId, scope: `POST /v1/savings/goals/${direction}`, key, body: { goalId, ...i },
      precheck: async () => {
        const g = await this.owned(customerId, goalId);
        if (g.status === 'CLOSED') throw new ConflictException({ code: 'goal_closed', message: 'This goal is closed' });
        const acc = await this.prisma.account.findUnique({ where: { id: i.accountId } });
        if (!acc || acc.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
        if (acc.status !== 'ACTIVE') throw new ConflictException({ code: 'account_restricted', message: 'The account must be active' });
        await this.pins.verify(customerId, i.pin);
      },
      run: async (tx) => {
        const goal = await tx.savingsGoal.findUniqueOrThrow({ where: { id: goalId } });
        const acc = await tx.ledgerAccount.findUniqueOrThrow({ where: { accountId: i.accountId } });
        const amount = BigInt(i.amountMinor);
        const [from, to] = direction === 'CONTRIBUTE' ? [acc.id, goal.ledgerAccountId] : [goal.ledgerAccountId, acc.id];
        try {
          await this.ledger.post({ reference: `GOAL-${direction[0]}-${createHash('sha256').update(`${customerId}:${key}`).digest('hex').slice(0, 24)}`, kind: direction === 'CONTRIBUTE' ? 'GOAL_CONTRIBUTION' : 'GOAL_WITHDRAWAL', currency: acc.currency, description: `${direction === 'CONTRIBUTE' ? 'Saved towards' : 'Withdrawn from'} ${goal.name}`, postings: [
            { ledgerAccountId: from, direction: 'DEBIT', amountMinor: amount, currency: acc.currency },
            { ledgerAccountId: to, direction: 'CREDIT', amountMinor: amount, currency: acc.currency } ] }, tx);
        } catch (e) {
          if (e instanceof LedgerRejection) throw new UnprocessableEntityException({ code: e.code.toLowerCase(), message: e.code === 'INSUFFICIENT_FUNDS' ? (direction === 'CONTRIBUTE' ? 'Insufficient funds in the account' : 'That is more than you have saved in this goal') : e.message });
          throw e;
        }
        const saved = (await tx.ledgerAccount.findUniqueOrThrow({ where: { id: goal.ledgerAccountId } })).balanceMinor;
        const reached = saved >= goal.targetMinor;
        let status = goal.status;
        if (reached && goal.status === 'ACTIVE') {
          status = 'ACHIEVED';
          await tx.savingsGoal.update({ where: { id: goalId }, data: { status } });
          await queueNotifications(tx, 'savings.goal_achieved', [{ userId: customerId, category: 'ACCOUNT', title: 'Goal reached!', body: `You have saved ${lkr(saved)} for "${goal.name}".` }]);
        } else if (!reached && goal.status === 'ACHIEVED') {
          status = 'ACTIVE';
          await tx.savingsGoal.update({ where: { id: goalId }, data: { status } });
        }
        await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: direction === 'CONTRIBUTE' ? 'savings.contributed' : 'savings.withdrawn', subjectType: 'SavingsGoal', subjectId: goalId, metadata: { amountMinor: amount.toString() } }, tx);
        return this.view({ ...goal, status }, saved);
      },
    });
    return { body: result, replayed };
  }

  async close(customerId: string, id: string) {
    const g = await this.owned(customerId, id);
    const saved = (await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: g.ledgerAccountId } })).balanceMinor;
    if (saved !== 0n) throw new ConflictException({ code: 'goal_not_empty', message: 'Withdraw your savings from this goal before closing it' });
    await this.prisma.savingsGoal.update({ where: { id }, data: { status: 'CLOSED' } });
  }

  // ───────────────────────── budgets ─────────────────────────
  async budgets(customerId: string, now = new Date()) {
    const { start } = bankingMonth(now);
    const [rows, paid] = await Promise.all([
      this.prisma.budget.findMany({ where: { customerId }, orderBy: { category: 'asc' } }),
      this.prisma.paymentInstruction.findMany({ where: { initiatorId: customerId, status: 'POSTED', postedAt: { gte: start } }, select: { kind: true, destination: true, amountMinor: true } }),
    ]);
    const spent = new Map<string, bigint>();
    for (const p of paid) {
      const c = paymentCategory(p.kind, p.destination);
      if (c) spent.set(c, (spent.get(c) ?? 0n) + p.amountMinor);
    }
    return {
      items: rows.map((b) => {
        const s = spent.get(b.category) ?? 0n;
        const pct = b.limitMinor > 0n ? Number((s * 100n) / b.limitMinor) : 0;
        return { category: b.category, limitMinor: num(b.limitMinor), spentMinor: num(s), remainingMinor: num(b.limitMinor - s), percentUsed: pct, state: pct >= 100 ? 'OVER' : pct >= 80 ? 'NEAR' : 'OK' };
      }),
      categories: BUDGET_CATEGORIES,
    };
  }

  async setBudget(customerId: string, category: string, limitMinor: number) {
    if (!BUDGET_CATEGORIES.includes(category)) throw new BadRequestException({ code: 'invalid_category', message: 'Unknown spending category' });
    await this.prisma.budget.upsert({ where: { customerId_category: { customerId, category } }, update: { limitMinor: BigInt(limitMinor), alertLevel: 0, alertMonth: null }, create: { customerId, category, limitMinor: BigInt(limitMinor) } });
    return this.budgets(customerId);
  }

  async deleteBudget(customerId: string, category: string) {
    const r = await this.prisma.budget.deleteMany({ where: { customerId, category } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Budget not found' });
  }

  /**
   * Called after a payment posts. Notifies ONCE per threshold (80%, 100%) per month. Never blocks or fails a payment:
   * budgets are the customer's own targets. The compare-and-set makes concurrent payments notify only once.
   */
  async checkAfterPayment(customerId: string, kind: PaymentKind, destination: unknown, now = new Date()): Promise<void> {
    const category = paymentCategory(kind, destination);
    if (!category) return;
    const b = await this.prisma.budget.findUnique({ where: { customerId_category: { customerId, category } } });
    if (!b) return;
    const { start, label } = bankingMonth(now);
    const agg = await this.prisma.paymentInstruction.findMany({ where: { initiatorId: customerId, status: 'POSTED', postedAt: { gte: start } }, select: { kind: true, destination: true, amountMinor: true } });
    const spent = agg.filter((p) => paymentCategory(p.kind, p.destination) === category).reduce((s, p) => s + p.amountMinor, 0n);
    const pct = b.limitMinor > 0n ? Number((spent * 100n) / b.limitMinor) : 0;
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (level === 0) return;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.budget.updateMany({ where: { id: b.id, OR: [{ alertMonth: { not: label } }, { alertMonth: null }, { alertLevel: { lt: level } }] }, data: { alertLevel: level, alertMonth: label } });
      if (claimed.count !== 1) return;
      await queueNotifications(tx, 'budget.alert', [{ userId: customerId, category: 'BUDGET', title: level === 100 ? 'Budget reached' : 'Budget almost used', body: level === 100 ? `You have used ${pct}% of your ${category} budget this month (${lkr(spent)} of ${lkr(b.limitMinor)}).` : `You have used ${pct}% of your ${category} budget this month.` }]);
    });
  }
}
