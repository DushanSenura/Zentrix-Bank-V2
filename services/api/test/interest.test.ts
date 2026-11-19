import { describe, expect, it } from 'vitest';
import { addMonths, earlyClosure, simpleInterest, validTerm } from '../src/modules/deposits/interest';

describe('fixed deposit interest (integer minor units, round down)', () => {
  it('simple interest for the term', () => {
    expect(simpleInterest(1_000_000n, 750, 3)).toBe(18_750n); // LKR 10,000 at 7.5% for 3 months = LKR 187.50
    expect(simpleInterest(1_000_000n, 900, 12)).toBe(90_000n);
    expect(simpleInterest(10_000_000n, 1100, 120)).toBe(11_000_000n); // 10 years simple
  });
  it('always rounds DOWN and never goes negative', () => {
    expect(simpleInterest(1001n, 750, 3)).toBe(18n); // 18.77 -> 18
    expect(simpleInterest(1n, 750, 3)).toBe(0n);
    expect(simpleInterest(0n, 900, 12)).toBe(0n);
  });
  it('handles very large principals without overflow', () => {
    expect(simpleInterest(9_007_199_254_740_991n, 1100, 120)).toBe((9_007_199_254_740_991n * 1100n * 120n) / 120_000n);
  });
});

describe('addMonths', () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  it('clamps to the end of shorter months', () => {
    expect(iso(addMonths(new Date('2027-01-31T00:00:00Z'), 1))).toBe('2027-02-28');
    expect(iso(addMonths(new Date('2028-01-31T00:00:00Z'), 1))).toBe('2028-02-29'); // leap year
    expect(iso(addMonths(new Date('2027-08-31T00:00:00Z'), 6))).toBe('2028-02-29');
  });
  it('crosses year boundaries', () => {
    expect(iso(addMonths(new Date('2026-11-15T00:00:00Z'), 3))).toBe('2027-02-15');
    expect(iso(addMonths(new Date('2026-11-15T00:00:00Z'), 24))).toBe('2028-11-15');
  });
});

describe('early closure', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  it('pays interest at (rate - penalty) for the days held and reports the penalty separately', () => {
    const r = earlyClosure(1_000_000n, 900, 300, start, new Date('2027-01-01T00:00:00Z')); // 365 days
    expect(r).toEqual({ interestMinor: 60_000n, penaltyMinor: 30_000n, payoutMinor: 1_060_000n });
  });
  it('pays only the principal on day zero', () => {
    expect(earlyClosure(1_000_000n, 900, 300, start, start).payoutMinor).toBe(1_000_000n);
  });
  it('a penalty at or above the rate removes all interest but never goes negative', () => {
    const r = earlyClosure(1_000_000n, 900, 1200, start, new Date('2027-01-01T00:00:00Z'));
    expect(r.interestMinor).toBe(0n);
    expect(r.penaltyMinor).toBe(90_000n);
    expect(r.payoutMinor).toBe(1_000_000n);
  });
  it('a clock earlier than the start date yields zero interest, not negative', () => {
    expect(earlyClosure(1_000_000n, 900, 300, start, new Date('2025-01-01T00:00:00Z')).interestMinor).toBe(0n);
  });
});

describe('validTerm (V1 rule)', () => {
  it('accepts 3, 6, 12 and whole years 24..120 only', () => {
    for (const ok of [3, 6, 12, 24, 36, 120]) expect(validTerm(ok)).toBe(true);
    for (const bad of [0, 1, 2, 4, 9, 18, 34, 25, 132, -12]) expect(validTerm(bad)).toBe(false);
  });
});
