import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DB } from './helpers';

describe.skipIf(!TEST_DB)('database indexes', () => {
  const db = new PrismaClient();
  afterAll(async () => { await db.$disconnect(); });

  /** Parent-row deletes and joins on an un-indexed foreign key scan the whole child table. */
  it('every foreign key column leads an index (or is explicitly accepted as small)', async () => {
    const rows = await db.$queryRawUnsafe<{ tbl: string; col: string }[]>(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
      ORDER BY 1, 2`);
    const missing = rows.map((r) => `${r.tbl}.${r.col}`);
    expect(missing, `foreign keys without a leading index:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the hot queries have an index to use (planner told it may not scan the table)', async () => {
    const plan = async (sql: string) => {
      const out = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off'); // if a query still needs a Seq Scan, no index can serve it
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`);
      });
      return out.map((r) => r['QUERY PLAN']).join('\n');
    };
    const U = '00000000-0000-4000-8000-000000000001';
    const queries: Record<string, string> = {
      'statement opening balance': `SELECT SUM("amountMinor") FROM "LedgerPosting" WHERE "ledgerAccountId" = '${U}' AND "createdAt" < now()`,
      'transaction search page': `SELECT * FROM "LedgerPosting" WHERE "ledgerAccountId" = '${U}' ORDER BY "createdAt" DESC, id DESC LIMIT 26`,
      'customer spending this month': `SELECT * FROM "PaymentInstruction" WHERE "initiatorId" = '${U}' AND status = 'POSTED' AND "postedAt" >= now() - interval '30 days'`,
      'risk scan (recent posted payments)': `SELECT * FROM "PaymentInstruction" WHERE status = 'POSTED' AND "postedAt" >= now() - interval '3 hours' AND kind <> 'OWN_TRANSFER' ORDER BY "postedAt" LIMIT 1000`,
      'notification centre': `SELECT * FROM "Notification" WHERE "userId" = '${U}' ORDER BY "createdAt" DESC LIMIT 50`,
      'outbox relay': `SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL ORDER BY "createdAt" LIMIT 50`,
      'due scheduled payments': `SELECT * FROM "ScheduledPayment" WHERE active = true AND "nextRunAt" <= now()`,
      'maturing deposits': `SELECT * FROM "FixedDeposit" WHERE status = 'ACTIVE' AND "maturityDate" <= now() + interval '7 days'`,
      'overdue loan instalments': `SELECT * FROM "LoanRepaymentSchedule" WHERE status IN ('DUE','PARTIAL') AND "dueDate" < now()`,
      'staff dispute queue': `SELECT * FROM "Dispute" WHERE status = 'OPEN' ORDER BY "createdAt" LIMIT 100`,
      'risk alert queue': `SELECT * FROM "RiskAlert" WHERE status = 'OPEN' ORDER BY "createdAt" DESC LIMIT 100`,
      'audit trail for an object': `SELECT * FROM "AuditLog" WHERE "subjectType" = 'Account' AND "subjectId" = '${U}'`,
      'sign-in history': `SELECT * FROM "LoginHistory" WHERE "userId" = '${U}' ORDER BY "createdAt" DESC LIMIT 20`,
      'customer accounts': `SELECT * FROM "Account" WHERE "customerId" = '${U}'`,
    };
    const scans: string[] = [];
    for (const [name, sql] of Object.entries(queries)) if (/Seq Scan/.test(await plan(sql))) scans.push(name);
    expect(scans, `queries with no usable index: ${scans.join('; ')}`).toEqual([]);
  });
});
