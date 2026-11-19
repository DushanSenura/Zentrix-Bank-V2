/**
 * Fixed-deposit interest maths. Integer minor units only (bigint); every division rounds DOWN, so the bank never
 * pays out a fraction of a cent it has not computed. V1 rule kept: SIMPLE interest for the term.
 */

/** interest = principal * rate * months / 12 (rate in basis points). */
export function simpleInterest(principalMinor: bigint, rateBps: number, months: number): bigint {
  return (principalMinor * BigInt(rateBps) * BigInt(months)) / (12n * 10_000n);
}

/** Calendar month arithmetic in UTC with end-of-month clamping (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: Date, months: number): Date {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/**
 * Early closure: interest accrues daily (actual/365) at the deposit rate MINUS a configurable penalty (floored at 0).
 * The penalty amount is the difference, reported separately so it can be shown and audited.
 */
export function earlyClosure(principalMinor: bigint, rateBps: number, penaltyBps: number, start: Date, now: Date): { interestMinor: bigint; penaltyMinor: bigint; payoutMinor: bigint } {
  const days = BigInt(Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86_400_000)));
  const at = (bps: number) => (principalMinor * BigInt(bps) * days) / (365n * 10_000n);
  const full = at(rateBps);
  const effective = at(Math.max(0, rateBps - penaltyBps));
  return { interestMinor: effective, penaltyMinor: full - effective, payoutMinor: principalMinor + effective };
}

/** V1 term rule: 3, 6 or 12 months, or a whole number of years from 24 to 120 months. */
export const validTerm = (m: number): boolean => m === 3 || m === 6 || m === 12 || (m >= 24 && m <= 120 && m % 12 === 0);
