import { describe, expect, it } from 'vitest';
import { assertBalanced, formatMinor, LedgerError, parseMajorToMinor, reversalOf, type PostingInput } from '../src/modules/ledger/money';

const p = (direction: 'DEBIT' | 'CREDIT', amountMinor: bigint, currency = 'LKR', id = 'a'): PostingInput => ({
  ledgerAccountId: id,
  direction,
  amountMinor,
  currency,
});

describe('money parsing/formatting', () => {
  it('parses without floating point error', () => {
    expect(parseMajorToMinor('2500.50')).toBe(250050n);
    expect(parseMajorToMinor('0.1')).toBe(10n);
    expect(parseMajorToMinor('19.99')).toBe(1999n);
    expect(parseMajorToMinor('5')).toBe(500n);
  });
  it('rejects bad input', () => {
    for (const bad of ['', '-1', '1.234', 'abc', '1,000']) {
      expect(() => parseMajorToMinor(bad)).toThrow(LedgerError);
    }
  });
  it('formats minor units', () => {
    expect(formatMinor(250050n)).toBe('2500.50');
    expect(formatMinor(5n)).toBe('0.05');
    expect(formatMinor(-1999n)).toBe('-19.99');
  });
});

describe('assertBalanced', () => {
  it('accepts a balanced journal', () => {
    expect(() => assertBalanced([p('DEBIT', 1000n, 'LKR', 'a'), p('CREDIT', 1000n, 'LKR', 'b')])).not.toThrow();
  });
  it('accepts multi-leg journals (transfer + fee)', () => {
    expect(() =>
      assertBalanced([p('DEBIT', 1025n), p('CREDIT', 1000n, 'LKR', 'b'), p('CREDIT', 25n, 'LKR', 'fee')]),
    ).not.toThrow();
  });
  it('rejects unbalanced, mixed-currency, empty, and non-positive', () => {
    expect(() => assertBalanced([p('DEBIT', 1000n), p('CREDIT', 999n)])).toThrowError(/do not equal/);
    expect(() => assertBalanced([p('DEBIT', 1000n), p('CREDIT', 1000n, 'USD')])).toThrowError(/single currency/);
    expect(() => assertBalanced([p('DEBIT', 1000n)])).toThrowError(/at least two/);
    expect(() => assertBalanced([p('DEBIT', 0n), p('CREDIT', 0n)])).toThrowError(/positive/);
    expect(() => assertBalanced([p('DEBIT', -5n), p('CREDIT', -5n)])).toThrowError(/positive/);
  });
});

describe('reversalOf', () => {
  it('mirrors directions and stays balanced', () => {
    const orig = [p('DEBIT', 1000n, 'LKR', 'a'), p('CREDIT', 1000n, 'LKR', 'b')];
    const rev = reversalOf(orig);
    expect(rev.map((x) => x.direction)).toEqual(['CREDIT', 'DEBIT']);
    expect(() => assertBalanced(rev)).not.toThrow();
    expect(orig[0]!.direction).toBe('DEBIT'); // original untouched
  });
});
