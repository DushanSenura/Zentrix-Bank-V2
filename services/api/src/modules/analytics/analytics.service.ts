import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { colomboStart } from '../documents/documents.service';
import { paymentCategory } from '../savings/savings.service';
import { detectRecurring } from './recurring';

const OFFSET_MS = 5.5 * 3_600_000;
const DAY = 86_400_000;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : 0; };

export const monthLabel = (d: Date) => { const l = new Date(d.getTime() + OFFSET_MS); return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}`; };
export const shiftMonth = (label: string, by: number) => { const [y, m] = label.split('-').map(Number) as [number, number]; const t = y * 12 + (m - 1) + by; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const bounds = (label: string) => ({ start: colomboStart(`${label}-01`), end: colomboStart(`${shiftMonth(label, 1)}-01`) });
const pct = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

export interface Insight { kind: 'FACT' | 'ESTIMATE'; title: string; detail: string }

/**
 * Customer-scoped, READ-ONLY analytics over persisted ledger and payment data. Every figure is computed from the
 * customer's own rows; nothing here can create or change a payment, and the AI module may only call this service.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private validMonth(m?: string, now = new Date()) {
    const label = m ?? monthLabel(now);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(label)) throw new BadRequestException({ code: 'validation_failed', message: 'Month must look like 2026-03' });
    return label;
  }

  private async moneyIn(customerId: string, start: Date, end: Date): Promise<number> {
    const r = await this.prisma.$queryRaw<{ v: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(lp."amountMinor"), 0)::bigint AS v
      FROM "LedgerPosting" lp
      JOIN "LedgerAccount" la ON la.id = lp."ledgerAccountId"
      JOIN "Account" a ON a.id = la."accountId"
      JOIN "LedgerJournal" j ON j.id = lp."journalId"
      LEFT JOIN "PaymentInstruction" pi ON pi.id = j."paymentId"
      WHERE a."customerId" = ${customerId}::uuid AND lp.direction = 'CREDIT' AND lp.currency = 'LKR' AND j.kind <> 'FX_EXCHANGE' AND lp."createdAt" >= ${start} AND lp."createdAt" < ${end}
        AND (pi.id IS NULL OR pi."initiatorId" <> ${customerId}::uuid)`);
    return num(r[0]?.v ?? 0n);
  }

  private async spending(customerId: string, start: Date, end: Date) {
    const paid = await this.prisma.paymentInstruction.findMany({ where: { initiatorId: customerId, status: 'POSTED', postedAt: { gte: start, lt: end } }, select: { id: true, reference: true, kind: true, destination: true, amountMinor: true, postedAt: true } });
    const byCat = new Map<string, number>();
    const items: { reference: string; category: string; amountMinor: number; postedAt: Date }[] = [];
    for (const p of paid) {
      const c = paymentCategory(p.kind, p.destination);
      if (!c) continue; // moves between your own accounts are not spending
      byCat.set(c, (byCat.get(c) ?? 0) + num(p.amountMinor));
      items.push({ reference: p.reference, category: c, amountMinor: num(p.amountMinor), postedAt: p.postedAt! });
    }
    return { byCat, items, total: [...byCat.values()].reduce((a, b) => a + b, 0) };
  }

  /** One banking month (Sri Lanka time): money in, spending, categories compared with the previous month, largest payments. */
  async summary(customerId: string, month?: string, now = new Date()) {
    const label = this.validMonth(month, now);
    const cur = bounds(label);
    const prevLabel = shiftMonth(label, -1);
    const prev = bounds(prevLabel);
    const [spent, prevSpent, inNow, inPrev] = await Promise.all([this.spending(customerId, cur.start, cur.end), this.spending(customerId, prev.start, prev.end), this.moneyIn(customerId, cur.start, cur.end), this.moneyIn(customerId, prev.start, prev.end)]);
    const categories = [...spent.byCat.entries()].sort((a, b) => b[1] - a[1]).map(([category, amountMinor]) => ({ category, spentMinor: amountMinor, sharePercent: spent.total ? Math.round((amountMinor / spent.total) * 100) : 0, previousMinor: prevSpent.byCat.get(category) ?? 0, changePercent: pct(amountMinor, prevSpent.byCat.get(category) ?? 0) }));
    const budgets = await this.prisma.budget.findMany({ where: { customerId } });
    return {
      month: label, previousMonth: prevLabel, currency: 'LKR',
      moneyInMinor: inNow, spentMinor: spent.total, netMinor: inNow - spent.total,
      previous: { moneyInMinor: inPrev, spentMinor: prevSpent.total },
      spentChangePercent: pct(spent.total, prevSpent.total),
      categories,
      largestPayments: [...spent.items].sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 3),
      budgets: budgets.map((b) => { const s = spent.byCat.get(b.category) ?? 0; return { category: b.category, limitMinor: num(b.limitMinor), spentMinor: s, percentUsed: b.limitMinor > 0n ? Math.round((s * 100) / num(b.limitMinor)) : 0 }; }),
      note: 'Money in counts everything credited to your accounts except your own transfers. Spending counts completed payments you made, excluding moves between your own accounts.',
    };
  }

  /** Month-by-month totals for charts (oldest first). */
  async trend(customerId: string, months = 6, now = new Date()) {
    const n = Math.min(Math.max(Math.trunc(months), 2), 12);
    const labels = Array.from({ length: n }, (_, i) => shiftMonth(monthLabel(now), i - (n - 1)));
    const items = await Promise.all(labels.map(async (label) => { const b = bounds(label); const [s, i] = await Promise.all([this.spending(customerId, b.start, b.end), this.moneyIn(customerId, b.start, b.end)]); return { month: label, spentMinor: s.total, moneyInMinor: i, topCategory: [...s.byCat.entries()].sort((a, b2) => b2[1] - a[1])[0]?.[0] ?? null }; }));
    return { items };
  }

  /** Recurring-expense analysis over the last ~200 days. */
  async recurring(customerId: string, now = new Date()) {
    const rows = await this.prisma.paymentInstruction.findMany({ where: { initiatorId: customerId, status: 'POSTED', postedAt: { gte: new Date(now.getTime() - 200 * DAY) } }, orderBy: { postedAt: 'asc' }, take: 1000, select: { destination: true, amountMinor: true, postedAt: true } });
    const items = detectRecurring(rows);
    return { items, monthlyTotalMinor: items.reduce((a, r) => a + r.monthlyEquivalentMinor, 0), note: 'Detected from your payment history (same recipient and amount at regular intervals). Informational only.' };
  }

  /** Plain statements, each labelled FACT (counted from your records) or ESTIMATE (a statistical projection). */
  async insights(customerId: string, now = new Date()): Promise<{ month: string; items: Insight[] }> {
    const s = await this.summary(customerId, undefined, now);
    const items: Insight[] = [];
    const lkr = (m: number) => `LKR ${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (s.spentMinor === 0) items.push({ kind: 'FACT', title: 'No spending recorded yet this month', detail: 'Completed payments will appear here.' });
    else {
      items.push({ kind: 'FACT', title: `You have spent ${lkr(s.spentMinor)} this month`, detail: s.spentChangePercent === null ? 'There is no spending last month to compare with.' : `That is ${Math.abs(s.spentChangePercent)}% ${s.spentChangePercent >= 0 ? 'more' : 'less'} than all of last month (${lkr(s.previous.spentMinor)}).` });
      const top = s.categories[0];
      if (top) items.push({ kind: 'FACT', title: `${top.category} is your biggest category`, detail: `${lkr(top.spentMinor)}, ${top.sharePercent}% of this month's spending.` });
      const l = new Date(now.getTime() + OFFSET_MS);
      const day = l.getUTCDate();
      const dim = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 1, 0)).getUTCDate();
      if (day >= 7 && day < dim) items.push({ kind: 'ESTIMATE', title: `At this pace you may spend about ${lkr(Math.round((s.spentMinor / day) * dim))} by month end`, detail: `A straight-line projection from ${day} days of data; real spending will vary.` });
      for (const b of s.budgets) {
        if (b.limitMinor > 0 && day >= 7 && day < dim) {
          const projected = Math.round((b.spentMinor / day) * dim);
          if (projected > b.limitMinor && b.spentMinor <= b.limitMinor) items.push({ kind: 'ESTIMATE', title: `${b.category} may go over budget`, detail: `Projected ${lkr(projected)} against a limit of ${lkr(b.limitMinor)}.` });
        }
        if (b.spentMinor > b.limitMinor && b.limitMinor > 0) items.push({ kind: 'FACT', title: `${b.category} is over budget`, detail: `${lkr(b.spentMinor)} spent against a limit of ${lkr(b.limitMinor)}.` });
      }
      const amounts = s.largestPayments.length ? (await this.spending(customerId, bounds(s.month).start, bounds(s.month).end)).items.map((i) => i.amountMinor) : [];
      const med = median(amounts);
      const big = s.largestPayments[0];
      if (big && amounts.length >= 5 && big.amountMinor >= 3 * med) items.push({ kind: 'ESTIMATE', title: 'One payment is much larger than your usual', detail: `${lkr(big.amountMinor)} to ${big.category.toLowerCase()} is over three times your typical payment this month. If you recognise it, no action is needed.` });
    }
    const rec = await this.recurring(customerId, now);
    if (rec.items.length) items.push({ kind: 'ESTIMATE', title: `${rec.items.length} regular payment${rec.items.length === 1 ? '' : 's'} detected, about ${lkr(rec.monthlyTotalMinor)} a month`, detail: rec.items.slice(0, 3).map((r) => `${r.name} ${lkr(r.amountMinor)} ${r.frequency.toLowerCase()}`).join('; ') });
    return { month: s.month, items };
  }
}
