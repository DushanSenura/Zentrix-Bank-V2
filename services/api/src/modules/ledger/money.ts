/**
 * Money and journal-balance primitives for the double-entry ledger.
 * All amounts are integer minor units (bigint). Floats are never used for authoritative money.
 */

export type Direction = 'DEBIT' | 'CREDIT';

export interface PostingInput {
  ledgerAccountId: string;
  direction: Direction;
  amountMinor: bigint;
  currency: string;
}

export class LedgerError extends Error {
  constructor(
    public readonly code: 'EMPTY_JOURNAL' | 'NON_POSITIVE_AMOUNT' | 'UNBALANCED' | 'MIXED_CURRENCY' | 'BAD_AMOUNT',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** Parses a decimal major-unit string ("2500.50") into minor units without floating point. */
export function parseMajorToMinor(input: string, minorDigits = 2): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) throw new LedgerError('BAD_AMOUNT', 'Amount must be a non-negative decimal number');
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > minorDigits) throw new LedgerError('BAD_AMOUNT', `At most ${minorDigits} decimal places allowed`);
  return BigInt(whole + frac.padEnd(minorDigits, '0'));
}

/** Formats minor units as a major-unit decimal string ("250050" -> "2500.50"). */
export function formatMinor(minor: bigint, minorDigits = 2): string {
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(minorDigits + 1, '0');
  const whole = abs.slice(0, abs.length - minorDigits);
  const frac = abs.slice(abs.length - minorDigits);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Throws unless the postings form a valid, balanced journal:
 * non-empty, single currency, every amount > 0, total debits == total credits.
 * The database enforces the same rule with a deferred constraint trigger (defence in depth).
 */
export function assertBalanced(postings: readonly PostingInput[]): void {
  if (postings.length < 2) throw new LedgerError('EMPTY_JOURNAL', 'A journal needs at least two postings');
  const currency = postings[0]!.currency;
  let debit = 0n;
  let credit = 0n;
  for (const p of postings) {
    if (p.currency !== currency) throw new LedgerError('MIXED_CURRENCY', 'A journal must use a single currency');
    if (p.amountMinor <= 0n) throw new LedgerError('NON_POSITIVE_AMOUNT', 'Posting amounts must be positive');
    if (p.direction === 'DEBIT') debit += p.amountMinor;
    else credit += p.amountMinor;
  }
  if (debit !== credit) throw new LedgerError('UNBALANCED', `Debits (${debit}) do not equal credits (${credit})`);
}

/** Builds the mirror-image postings that reverse a posted journal (never delete the original). */
export function reversalOf(postings: readonly PostingInput[]): PostingInput[] {
  assertBalanced(postings);
  return postings.map((p) => ({ ...p, direction: p.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' }));
}
