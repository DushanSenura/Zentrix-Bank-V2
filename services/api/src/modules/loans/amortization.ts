import { addMonths } from '../deposits/interest';

/**
 * Loan amortisation in INTEGER arithmetic only (bigint, 18-digit fixed point for the compounding factor). No floating
 * point touches money. Rounding is half-up to the minor unit, and the LAST instalment absorbs the rounding residue so the
 * principal parts always sum to the loan amount exactly.
 */
const SCALE = 10n ** 18n;
const roundDiv = (num: bigint, den: bigint): bigint => (num + den / 2n) / den;

/** Level monthly instalment (EMI) for an annual rate in basis points. */
export function emi(principalMinor: bigint, rateBps: number, months: number): bigint {
  if (months <= 0) throw new RangeError('months must be positive');
  if (rateBps === 0) return roundDiv(principalMinor, BigInt(months));
  const r = (BigInt(rateBps) * SCALE) / (12n * 10_000n); // monthly rate, scaled
  let growth = SCALE;
  for (let i = 0; i < months; i++) growth = (growth * (SCALE + r)) / SCALE; // (1+r)^n, scaled
  return roundDiv(principalMinor * r * growth, (growth - SCALE) * SCALE);
}

export interface Instalment {
  no: number;
  dueDate: Date;
  principalMinor: bigint;
  interestMinor: bigint;
  totalMinor: bigint;
}

export function buildSchedule(principalMinor: bigint, rateBps: number, months: number, start: Date): Instalment[] {
  const level = emi(principalMinor, rateBps, months);
  const out: Instalment[] = [];
  let balance = principalMinor;
  for (let k = 1; k <= months; k++) {
    const interest = roundDiv(balance * BigInt(rateBps), 12n * 10_000n);
    const last = k === months;
    const principal = last ? balance : level - interest > balance ? balance : level - interest;
    out.push({ no: k, dueDate: addMonths(start, k), principalMinor: principal, interestMinor: interest, totalMinor: principal + interest });
    balance -= principal;
  }
  return out;
}

export const totalInterest = (s: Instalment[]): bigint => s.reduce((a, i) => a + i.interestMinor, 0n);

/** Affordability estimate: share of monthly income taken by the instalment. INFORMATIONAL ONLY - never an approval. */
export function affordability(emiMinor: bigint, monthlyIncomeMinor: bigint, maxShareBps = 4000): { incomeShareBps: number; band: 'COMFORTABLE' | 'STRETCH' | 'UNLIKELY' } {
  if (monthlyIncomeMinor <= 0n) return { incomeShareBps: 10_000, band: 'UNLIKELY' };
  const share = Number((emiMinor * 10_000n) / monthlyIncomeMinor);
  return { incomeShareBps: share, band: share <= maxShareBps / 2 ? 'COMFORTABLE' : share <= maxShareBps ? 'STRETCH' : 'UNLIKELY' };
}
