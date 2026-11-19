const DAY = 86_400_000;

export interface PaidRow { destination: unknown; amountMinor: bigint; postedAt: Date | null }
export interface Recurring { name: string; amountMinor: number; frequency: 'WEEKLY' | 'MONTHLY'; occurrences: number; lastPaidAt: Date; nextExpectedAt: Date; annualCostMinor: number; monthlyEquivalentMinor: number }

/**
 * Same recipient and amount, at least 3 completed payments, spaced roughly a week or a month apart.
 * Pure and read-only: it describes what happened, it never creates or changes a payment.
 */
export function detectRecurring(rows: PaidRow[]): Recurring[] {
  const groups = new Map<string, PaidRow[]>();
  for (const r of rows) {
    if (!r.postedAt) continue;
    const d = (r.destination ?? {}) as Record<string, unknown>;
    const who = String(d.billerCode ?? d.accountNumber ?? d.toAccountId ?? d.name ?? '');
    if (!who) continue;
    const k = `${who}|${r.amountMinor}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Recurring[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.postedAt!.getTime() - b.postedAt!.getTime());
    if (list.length < 3) continue;
    const gaps = list.slice(1).map((r, i) => (r.postedAt!.getTime() - list[i]!.postedAt!.getTime()) / DAY);
    const weekly = gaps.every((g) => g >= 5 && g <= 9);
    const monthly = gaps.every((g) => g >= 26 && g <= 35);
    if (!weekly && !monthly) continue;
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const last = list[list.length - 1]!;
    const d = (last.destination ?? {}) as Record<string, unknown>;
    const amount = Number(last.amountMinor);
    out.push({
      name: String(d.billerName ?? d.name ?? d.billerCode ?? 'Recipient'), amountMinor: amount, frequency: weekly ? 'WEEKLY' : 'MONTHLY', occurrences: list.length,
      lastPaidAt: last.postedAt!, nextExpectedAt: new Date(last.postedAt!.getTime() + Math.round(avg) * DAY),
      annualCostMinor: amount * (weekly ? 52 : 12), monthlyEquivalentMinor: Math.round(weekly ? (amount * 52) / 12 : amount),
    });
  }
  return out.sort((a, b) => b.annualCostMinor - a.annualCostMinor);
}
