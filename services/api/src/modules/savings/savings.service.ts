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
export function paymentCategory(kind: PaymentKind, destination: unknown, chosen?: string | null): string | null {
  if (kind === 'OWN_TRANSFER') return null;
  if (chosen) return chosen; // the customer's own label wins
  switch (kind) {
    case 'BILL_PAYMENT': return (destination as { category?: string }).category ?? 'Other';
    case 'LOAN_INSTALMENT': return 'Loan repayments';
    default: return 'Transfers';
  }
}

/** The categories a customer can label a payment with (and budget against). */
export const SPENDING_CATEGORIES = ['Food', 'Shopping', 'Transport', 'Bills', 'Entertainment', 'Health', 'Education', 'Other'] as const;
export const BUDGET_CATEGORIES = [...new Set([...SPENDING_CATEGORIES, ...BILLERS.map((b) => b.category), 'Transfers', 'Loan repayments'])];

/** The same moment one calendar month later (clamped to the month's length). */
export function addMonth(d: Date): Date {
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t;
}

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
  private view(g: { id: string; name: string; targetMinor: bigint; targetDate: Date | null; status: string; createdAt: Date; monthlyAutoMinor?: bigint | null; autoSourceAccountId?: string | null; autoNextRunAt?: Date | null; autoLastFailure?: string | null }, saved: bigint) {
    const pct = g.targetMinor > 0n ? Number((saved * 100n) / g.targetMinor) : 0;
    return { id: g.id, name: g.name, targetMinor: num(g.targetMinor), savedMinor: num(saved), progressPercent: Math.min(100, pct), targetDate: g.targetDate?.toISOString() ?? null, status: g.status,
      autoSave: g.monthlyAutoMinor ? { monthlyMinor: num(g.monthlyAutoMinor), accountId: g.autoSourceAccountId ?? null, nextRunAt: g.autoNextRunAt?.toISOString() ?? null, lastFailure: g.autoLastFailure ?? null } : null };
  }

  async list(customerId: string) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { customerId, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'asc' } });
    const balances = new Map((await this.prisma.ledgerAccount.findMany({ where: { id: { in: goals.map((g) => g.ledgerAccountId) } } })).map((l) => [l.id, l.balanceMinor]));
    const items = goals.map((g) => this.view(g, balances.get(g.ledgerAccountId) ?? 0n));
    return { items, totalSavedMinor: items.reduce((s, i) => s + i.savedMinor, 0) };
  }

  /** Checks the account for a monthly auto-save and the customer's PIN. The PIN authorises the standing instruction once, here. */
  private async checkAuto(customerId: string, accountId: string, pin: string) {
    const acc = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!acc || acc.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    if (acc.status !== 'ACTIVE' || acc.currency !== 'LKR') throw new ConflictException({ code: 'account_restricted', message: 'Choose an active rupee account' });
    await this.pins.verify(customerId, pin);
  }

  async create(customerId: string, i: { name: string; targetMinor: number; targetDate?: string; monthlyAutoMinor?: number; autoAccountId?: string; pin?: string }) {
    if (i.monthlyAutoMinor) {
      if (!i.autoAccountId || !i.pin) throw new BadRequestException({ code: 'validation_failed', message: 'Choose the account and enter your PIN to turn on monthly saving' });
      await this.checkAuto(customerId, i.autoAccountId, i.pin);
    }
    const date = i.targetDate ? new Date(i.targetDate) : null;
    if (date && (Number.isNaN(date.getTime()) || date.getTime() < Date.now())) throw new BadRequestException({ code: 'validation_failed', message: 'Choose a target date in the future', fields: { targetDate: 'Invalid date' } });
    if ((await this.prisma.savingsGoal.count({ where: { customerId, status: { not: 'CLOSED' } } })) >= 20) throw new ConflictException({ code: 'goal_limit', message: 'You can have at most 20 active goals' });
    const g = await this.prisma.$transaction(async (tx) => {
      const id = crypto.randomUUID();
      const la = await tx.ledgerAccount.create({ data: { code: `GOAL-${id}`, name: `Savings goal ${id}`, type: 'LIABILITY', currency: 'LKR' } });
      const goal = await tx.savingsGoal.create({ data: { id, customerId, name: i.name, targetMinor: BigInt(i.targetMinor), targetDate: date, ledgerAccountId: la.id, ...(i.monthlyAutoMinor ? { monthlyAutoMinor: BigInt(i.monthlyAutoMinor), autoSourceAccountId: i.autoAccountId, autoNextRunAt: addMonth(new Date()) } : {}) } });
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'savings.goal_created', subjectType: 'SavingsGoal', subjectId: id }, tx);
      return goal;
    });
    return this.view(g, 0n);
  }

  /** Turns monthly saving on, changes it, or (monthlyAutoMinor null) turns it off. Turning on or changing needs the PIN. */
  async setAuto(customerId: string, goalId: string, i: { monthlyAutoMinor: number | null; accountId?: string; pin?: string }) {
    const g = await this.owned(customerId, goalId);
    if (g.status === 'CLOSED') throw new ConflictException({ code: 'goal_closed', message: 'This goal is closed' });
    if (i.monthlyAutoMinor === null) {
      const off = await this.prisma.savingsGoal.update({ where: { id: goalId }, data: { monthlyAutoMinor: null, autoSourceAccountId: null, autoNextRunAt: null, autoLastFailure: null } });
      return this.view(off, (await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: g.ledgerAccountId } })).balanceMinor);
    }
    if (!i.accountId || !i.pin) throw new BadRequestException({ code: 'validation_failed', message: 'Choose the account and enter your PIN' });
    await this.checkAuto(customerId, i.accountId, i.pin);
    const on = await this.prisma.savingsGoal.update({ where: { id: goalId }, data: { monthlyAutoMinor: BigInt(i.monthlyAutoMinor), autoSourceAccountId: i.accountId, autoNextRunAt: g.autoNextRunAt ?? addMonth(new Date()), autoLastFailure: null } });
    return this.view(on, (await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: g.ledgerAccountId } })).balanceMinor);
  }

  /**
   * Monthly saving, run by the job tick. Each goal is claimed with a compare-and-set on its next-run time and posted under a
   * reference that names the goal and the month, so a repeated tick can never save twice. A shortfall skips that month and says so.
   */
  async runAutoSaves(now = new Date()): Promise<{ saved: number; failed: number }> {
    let saved = 0, failed = 0;
    const due = await this.prisma.savingsGoal.findMany({ where: { status: 'ACTIVE', monthlyAutoMinor: { not: null }, autoNextRunAt: { lte: now } }, orderBy: { autoNextRunAt: 'asc' }, take: 200 });
    for (const g of due) {
      const dueAt = g.autoNextRunAt!;
      const next = addMonth(dueAt);
      const label = `${dueAt.getUTCFullYear()}${String(dueAt.getUTCMonth() + 1).padStart(2, '0')}`;
      try {
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.savingsGoal.updateMany({ where: { id: g.id, autoNextRunAt: dueAt, status: 'ACTIVE' }, data: { autoNextRunAt: next, autoLastFailure: null } });
          if (claimed.count !== 1) return;
          const acc = g.autoSourceAccountId ? await tx.account.findUnique({ where: { id: g.autoSourceAccountId }, include: { ledgerAccount: true } }) : null;
          if (!acc?.ledgerAccount || acc.status !== 'ACTIVE') throw new LedgerRejection('ACCOUNT_RESTRICTED', 'The account is not available');
          const amount = g.monthlyAutoMinor!;
          await this.ledger.post({ reference: `GOAL-AUTO-${g.id}-${label}`, kind: 'GOAL_CONTRIBUTION', currency: acc.currency, description: `Monthly saving towards ${g.name}`, postings: [
            { ledgerAccountId: acc.ledgerAccount.id, direction: 'DEBIT', amountMinor: amount, currency: acc.currency },
            { ledgerAccountId: g.ledgerAccountId, direction: 'CREDIT', amountMinor: amount, currency: acc.currency } ] }, tx);
          const total = (await tx.ledgerAccount.findUniqueOrThrow({ where: { id: g.ledgerAccountId } })).balanceMinor;
          await queueNotifications(tx, 'savings.auto_saved', [{ userId: g.customerId, category: 'ACCOUNT', title: 'Monthly saving made', body: `${lkr(amount)} was saved towards "${g.name}". You have ${lkr(total)} saved.` }]);
          if (total >= g.targetMinor) {
            await tx.savingsGoal.update({ where: { id: g.id }, data: { status: 'ACHIEVED', autoNextRunAt: null } });
            await queueNotifications(tx, 'savings.goal_achieved', [{ userId: g.customerId, category: 'ACCOUNT', title: 'Goal reached!', body: `You have saved ${lkr(total)} for "${g.name}".` }]);
          }
        });
        saved++;
      } catch (e) {
        if (!(e instanceof LedgerRejection)) throw e;
        failed++;
        await this.prisma.savingsGoal.update({ where: { id: g.id }, data: { autoNextRunAt: next, autoLastFailure: e.code === 'INSUFFICIENT_FUNDS' ? 'Not enough money in the account' : 'The account was not available' } });
        await queueNotifications(this.prisma, 'savings.auto_failed', [{ userId: g.customerId, category: 'ACCOUNT', title: 'Monthly saving skipped', body: `We could not save ${lkr(g.monthlyAutoMinor!)} towards "${g.name}" this month. ${e.code === 'INSUFFICIENT_FUNDS' ? 'The account did not have enough money.' : 'The account was not available.'}` }]);
      }
    }
    return { saved, failed };
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
      this.prisma.paymentInstruction.findMany({ where: { initiatorId: customerId, status: 'POSTED', postedAt: { gte: start } }, select: { kind: true, destination: true, category: true, amountMinor: true } }),
    ]);
    const spent = new Map<string, bigint>();
    for (const p of paid) {
      const c = paymentCategory(p.kind, p.destination, p.category);
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
  async checkAfterPayment(customerId: string, kind: PaymentKind, destination: unknown, now = new Date(), chosen?: string | null): Promise<void> {
    const category = paymentCategory(kind, destination, chosen);
    if (!category) return;
    const b = await this.prisma.budget.findUnique({ where: { customerId_category: { customerId, category } } });
    if (!b) return;
    const { start, label } = bankingMonth(now);
    const agg = await this.prisma.paymentInstruction.findMany({ where: { initiatorId: customerId, status: 'POSTED', postedAt: { gte: start } }, select: { kind: true, destination: true, category: true, amountMinor: true } });
    const spent = agg.filter((p) => paymentCategory(p.kind, p.destination, p.category) === category).reduce((s, p) => s + p.amountMinor, 0n);
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
