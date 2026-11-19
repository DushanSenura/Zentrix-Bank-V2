import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { assertBalanced, LedgerError, reversalOf, type PostingInput } from './money';

export type LedgerRejectionCode =
  | 'INSUFFICIENT_FUNDS'
  | 'ACCOUNT_RESTRICTED'
  | 'CURRENCY_MISMATCH'
  | 'UNKNOWN_ACCOUNT'
  | 'DUPLICATE_REFERENCE'
  | 'NOT_REVERSIBLE';

/** A business refusal from the ledger. Nothing was written. */
export class LedgerRejection extends Error {
  constructor(public readonly code: LedgerRejectionCode, message: string) {
    super(message);
    this.name = 'LedgerRejection';
  }
}

export interface PostInput {
  reference: string; // globally unique, e.g. receipt reference
  kind: string; // TRANSFER | FEE | ACCOUNT_OPENING | REVERSAL | ...
  currency: string;
  description?: string;
  paymentId?: string;
  reversesJournalId?: string;
  postings: PostingInput[];
}

export interface PostedJournal {
  journalId: string;
  reference: string;
}

interface LockedRow {
  id: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  currency: string;
  balanceMinor: bigint;
  allowNegative: boolean;
  accountId: string | null;
}

const CREDIT_NORMAL = new Set(['LIABILITY', 'EQUITY', 'INCOME']);

/** System (bank-internal) ledger accounts, created on first use. */
export const SYSTEM_ACCOUNTS = {
  cash: { code: 'SYS-CASH-LKR', name: 'Cash & settlement (LKR)', type: 'ASSET', allowNegative: true },
  feeIncome: { code: 'SYS-FEE-INCOME-LKR', name: 'Fee income (LKR)', type: 'INCOME', allowNegative: false },
  billers: { code: 'SYS-BILLERS-LKR', name: 'Biller settlement (LKR, simulated)', type: 'ASSET', allowNegative: true },
  interbank: { code: 'SYS-INTERBANK-LKR', name: 'Interbank settlement (LKR, simulated)', type: 'ASSET', allowNegative: true },
  interestIncome: { code: 'SYS-INTEREST-INCOME-LKR', name: 'Interest income (LKR)', type: 'INCOME', allowNegative: false },
  interestExpense: { code: 'SYS-INTEREST-EXPENSE-LKR', name: 'Interest expense (LKR)', type: 'EXPENSE', allowNegative: true },
} as const;

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the id of a system ledger account, creating it on first use (idempotent). */
  async systemAccountId(key: keyof typeof SYSTEM_ACCOUNTS, tx?: Prisma.TransactionClient): Promise<string> {
    const a = SYSTEM_ACCOUNTS[key];
    const db = tx ?? this.prisma;
    const row = await db.ledgerAccount.upsert({
      where: { code: a.code },
      update: {},
      create: { code: a.code, name: a.name, type: a.type, currency: 'LKR', allowNegative: a.allowNegative },
    });
    return row.id;
  }

  /**
   * Posts one balanced journal atomically.
   *  - locks every touched ledger account (FOR UPDATE, ascending id => no deadlocks between concurrent posts)
   *  - refuses restricted accounts, wrong currency, and any debit that would take a non-overdraft balance below zero
   *  - writes journal + postings and updates the balance projection in the SAME transaction
   * Pass `tx` to join a caller's transaction (then the caller's commit/rollback decides); otherwise one is opened.
   */
  async post(input: PostInput, tx?: Prisma.TransactionClient): Promise<PostedJournal> {
    assertBalanced(input.postings); // throws LedgerError before touching the DB
    if (input.postings.some((p) => p.currency !== input.currency)) throw new LedgerError('MIXED_CURRENCY', 'Posting currency differs from journal currency');
    if (tx) return this.postIn(tx, input);
    return this.prisma.$transaction((t) => this.postIn(t, input), { maxWait: 5000, timeout: 10000 });
  }

  private async postIn(tx: Prisma.TransactionClient, input: PostInput): Promise<PostedJournal> {
    const ids = [...new Set(input.postings.map((p) => p.ledgerAccountId))].sort();
    const rows = await tx.$queryRaw<LockedRow[]>(Prisma.sql`
      SELECT id, type::text AS type, currency, "balanceMinor", "allowNegative", "accountId"
      FROM "LedgerAccount" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== ids.length) throw new LedgerRejection('UNKNOWN_ACCOUNT', 'A ledger account does not exist');

    // Customer-account restrictions. FOR SHARE makes a concurrent freeze wait for this post (and vice versa).
    const accountIds = rows.map((r) => r.accountId).filter((x): x is string => !!x);
    const statuses = accountIds.length
      ? await tx.$queryRaw<{ id: string; status: string }[]>(Prisma.sql`SELECT id, status::text AS status FROM "Account" WHERE id = ANY(${accountIds}::uuid[]) FOR SHARE`)
      : [];
    const statusOf = new Map(statuses.map((s) => [s.id, s.status]));

    const delta = new Map<string, bigint>();
    for (const p of input.postings) {
      const row = byId.get(p.ledgerAccountId)!;
      if (row.currency !== p.currency) throw new LedgerRejection('CURRENCY_MISMATCH', 'Account currency does not match the posting');
      const status = row.accountId ? statusOf.get(row.accountId) : 'ACTIVE';
      const isDebit = p.direction === 'DEBIT';
      if (status === 'CLOSED' || status === 'SUSPENDED') throw new LedgerRejection('ACCOUNT_RESTRICTED', `Account is ${status!.toLowerCase()}`);
      if (status === 'FROZEN' && isDebit && CREDIT_NORMAL.has(row.type)) throw new LedgerRejection('ACCOUNT_RESTRICTED', 'Account is frozen');
      const normalIsCredit = CREDIT_NORMAL.has(row.type);
      const signed = (normalIsCredit ? !isDebit : isDebit) ? p.amountMinor : -p.amountMinor;
      delta.set(row.id, (delta.get(row.id) ?? 0n) + signed);
    }
    for (const [id, d] of delta) {
      const row = byId.get(id)!;
      if (d < 0n && !row.allowNegative && row.balanceMinor + d < 0n) throw new LedgerRejection('INSUFFICIENT_FUNDS', 'Insufficient funds');
    }

    let journalId: string;
    try {
      const j = await tx.ledgerJournal.create({
        data: {
          reference: input.reference,
          kind: input.kind,
          currency: input.currency,
          description: input.description,
          paymentId: input.paymentId,
          reversesJournalId: input.reversesJournalId,
          postings: { create: input.postings.map((p) => ({ ledgerAccountId: p.ledgerAccountId, direction: p.direction, amountMinor: p.amountMinor, currency: p.currency })) },
        },
      });
      journalId = j.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new LedgerRejection('DUPLICATE_REFERENCE', 'This reference was already posted');
      throw e;
    }
    for (const [id, d] of delta) await tx.ledgerAccount.update({ where: { id }, data: { balanceMinor: { increment: d } } });
    return { journalId, reference: input.reference };
  }

  /** Reverses a posted journal with an equal and opposite journal (the original is never edited or deleted). */
  async reverse(journalId: string, reference: string, description?: string, tx?: Prisma.TransactionClient): Promise<PostedJournal> {
    const run = async (t: Prisma.TransactionClient) => {
      // Serialise concurrent reversals of the same journal.
      await t.$queryRaw`SELECT id FROM "LedgerJournal" WHERE id = ${journalId}::uuid FOR UPDATE`;
      const j = await t.ledgerJournal.findUnique({ where: { id: journalId }, include: { postings: true, reversedBy: true } });
      if (!j) throw new LedgerRejection('NOT_REVERSIBLE', 'Journal not found');
      if (j.status !== 'POSTED' || j.reversedBy || j.reversesJournalId) throw new LedgerRejection('NOT_REVERSIBLE', 'Journal cannot be reversed');
      const mirrored = reversalOf(j.postings.map((p) => ({ ledgerAccountId: p.ledgerAccountId, direction: p.direction, amountMinor: p.amountMinor, currency: p.currency })));
      const out = await this.postIn(t, { reference, kind: 'REVERSAL', currency: j.currency, description: description ?? `Reversal of ${j.reference}`, reversesJournalId: j.id, postings: mirrored });
      await t.ledgerJournal.update({ where: { id: j.id }, data: { status: 'REVERSED' } });
      return out;
    };
    return tx ? run(tx) : this.prisma.$transaction(run, { maxWait: 5000, timeout: 10000 });
  }

  /**
   * Integrity check: (1) every projection equals the sum of its postings, (2) total debits == total credits per currency.
   * Read-only; safe to run at any time. Reports, never "fixes".
   */
  async reconcile(): Promise<{ ok: boolean; mismatches: { ledgerAccountId: string; code: string; projection: string; computed: string }[]; totals: { currency: string; debit: string; credit: string }[] }> {
    const mism = await this.prisma.$queryRaw<{ id: string; code: string; projection: bigint; computed: bigint }[]>`
      SELECT la.id, la.code, la."balanceMinor" AS projection,
        COALESCE(SUM(CASE WHEN (la.type IN ('LIABILITY','EQUITY','INCOME')) = (lp.direction = 'CREDIT') THEN lp."amountMinor" ELSE -lp."amountMinor" END), 0)::bigint AS computed
      FROM "LedgerAccount" la LEFT JOIN "LedgerPosting" lp ON lp."ledgerAccountId" = la.id
      GROUP BY la.id HAVING la."balanceMinor" <> COALESCE(SUM(CASE WHEN (la.type IN ('LIABILITY','EQUITY','INCOME')) = (lp.direction = 'CREDIT') THEN lp."amountMinor" ELSE -lp."amountMinor" END), 0)`;
    const totals = await this.prisma.$queryRaw<{ currency: string; debit: bigint; credit: bigint }[]>`
      SELECT currency, COALESCE(SUM("amountMinor") FILTER (WHERE direction='DEBIT'),0)::bigint AS debit, COALESCE(SUM("amountMinor") FILTER (WHERE direction='CREDIT'),0)::bigint AS credit
      FROM "LedgerPosting" GROUP BY currency`;
    const unbalanced = totals.some((t) => t.debit.toString() !== t.credit.toString());
    return {
      ok: mism.length === 0 && !unbalanced,
      mismatches: mism.map((m) => ({ ledgerAccountId: m.id, code: m.code, projection: m.projection.toString(), computed: m.computed.toString() })),
      totals: totals.map((t) => ({ currency: t.currency, debit: t.debit.toString(), credit: t.credit.toString() })),
    };
  }
}
