import { describe, expect, it } from 'vitest';
import { affordability, buildSchedule, emi, totalInterest } from '../src/modules/loans/amortization';

describe('EMI', () => {
  it('matches the standard annuity formula (LKR 1,000,000 at 12% for 12 months = LKR 88,848.79)', () => {
    expect(emi(100_000_000n, 1200, 12)).toBe(8_884_879n);
  });
  it('matches an independent floating-point cross-check (LKR 500,000 at 14.5% for 36 months = LKR 17,210.49)', () => {
    const e = emi(50_000_000n, 1450, 36); // cross-checked offline with the closed-form formula in doubles: 1_721_049 (+/-1)
    expect(e >= 1_721_048n && e <= 1_721_050n).toBe(true);
  });
  it('zero-rate loans split the principal evenly', () => {
    expect(emi(1_200_000n, 0, 12)).toBe(100_000n);
  });
  it('a one-month loan costs principal plus one month of interest', () => {
    const s = buildSchedule(1_000_000n, 1200, 1, new Date('2026-01-15T00:00:00Z'));
    expect(s).toHaveLength(1);
    expect(s[0]!.principalMinor).toBe(1_000_000n);
    expect(s[0]!.interestMinor).toBe(10_000n);
  });
  it('rejects non-positive terms', () => {
    expect(() => emi(1000n, 1000, 0)).toThrow(RangeError);
  });
});

describe('schedule', () => {
  const start = new Date('2026-01-31T00:00:00Z');
  for (const [p, bps, n] of [[100_000_000n, 1200, 12], [123_456_789n, 1375, 48], [5_000_000n, 950, 7], [99_999n, 2400, 36]] as const) {
    it(`principal parts sum to the loan exactly (P=${p}, ${bps}bps, ${n}m)`, () => {
      const s = buildSchedule(p, bps, n, start);
      expect(s).toHaveLength(n);
      expect(s.reduce((a, i) => a + i.principalMinor, 0n)).toBe(p); // never a cent lost or created
      expect(s.every((i) => i.principalMinor >= 0n && i.interestMinor >= 0n)).toBe(true);
      expect(s.every((i) => i.totalMinor === i.principalMinor + i.interestMinor)).toBe(true);
    });
  }
  it('interest falls and principal rises over the term (reducing balance)', () => {
    const s = buildSchedule(100_000_000n, 1200, 12, start);
    for (let i = 1; i < s.length - 1; i++) {
      expect(s[i]!.interestMinor <= s[i - 1]!.interestMinor).toBe(true);
      expect(s[i]!.principalMinor >= s[i - 1]!.principalMinor).toBe(true);
    }
    expect(totalInterest(s)).toBeGreaterThan(6_000_000n);
    expect(totalInterest(s)).toBeLessThan(7_000_000n);
  });
  it('level instalments except the last, which absorbs rounding', () => {
    const s = buildSchedule(100_000_000n, 1200, 12, start);
    expect(new Set(s.slice(0, -1).map((i) => i.totalMinor)).size).toBe(1);
    const diff = s[11]!.totalMinor - s[0]!.totalMinor;
    expect(diff >= -12n && diff <= 12n).toBe(true);
  });
  it('due dates are monthly with month-end clamping', () => {
    const s = buildSchedule(1_000_000n, 1200, 3, start);
    expect(s.map((i) => i.dueDate.toISOString().slice(0, 10))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

describe('affordability estimate', () => {
  it('bands the instalment against income', () => {
    expect(affordability(1_000_000n, 10_000_000n).band).toBe('COMFORTABLE'); // 10%
    expect(affordability(3_000_000n, 10_000_000n).band).toBe('STRETCH'); // 30%
    expect(affordability(5_000_000n, 10_000_000n).band).toBe('UNLIKELY'); // 50%
    expect(affordability(1n, 0n).band).toBe('UNLIKELY');
  });
});
