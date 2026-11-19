import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DB } from './helpers';

const DB_DIR = join(__dirname, '..', '..', '..', 'database');
const SCRATCH = `zentrix_migtest_${process.pid}`;
const withDb = (url: string, name: string) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

const prisma = (cmd: string[], url: string, ok = false, withSchema = true) => {
  try {
    return { code: 0, out: execFileSync('npx', ['prisma', ...cmd, ...(withSchema ? ['--schema', 'prisma/schema.prisma'] : [])], { cwd: DB_DIR, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    if (!ok) throw e;
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

describe.skipIf(!TEST_DB)('database migrations on a brand-new database', () => {
  const admin = new PrismaClient({ datasources: { db: { url: TEST_DB! } } });
  const scratchUrl = TEST_DB ? withDb(TEST_DB, SCRATCH) : '';
  afterAll(async () => { await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`).catch(() => undefined); await admin.$disconnect(); });

  it('applies every migration in order from nothing, leaves no drift from schema.prisma, and keeps the ledger safeguards', async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}"`);
    const deploy = prisma(['migrate', 'deploy'], scratchUrl);
    expect(deploy.out).toMatch(/successfully applied/i);

    // No drift: the migrations produce exactly the schema the code was generated against.
    const diff = prisma(['migrate', 'diff', '--from-url', scratchUrl, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], scratchUrl, true, false);
    expect(diff.code, `schema drift:\n${diff.out}`).toBe(0);

    // Running deploy again is a no-op (idempotent).
    expect(prisma(['migrate', 'deploy'], scratchUrl).out).toMatch(/No pending migrations/i);

    // The integrity triggers and constraints came through the migrations, not only through the test DB's history.
    const db = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
    try {
      const triggers = (await db.$queryRawUnsafe<{ tgname: string }[]>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).map((t) => t.tgname);
      expect(triggers.length).toBeGreaterThanOrEqual(2);
      const acct = await db.ledgerAccount.create({ data: { code: 'MIG-1', name: 'm1', type: 'LIABILITY', currency: 'LKR' } });
      const acct2 = await db.ledgerAccount.create({ data: { code: 'MIG-2', name: 'm2', type: 'ASSET', currency: 'LKR' } });
      const j = await db.ledgerJournal.create({ data: { reference: 'MIG-J1', kind: 'TEST', currency: 'LKR', postings: { create: [{ ledgerAccountId: acct2.id, direction: 'DEBIT', amountMinor: 100n, currency: 'LKR' }, { ledgerAccountId: acct.id, direction: 'CREDIT', amountMinor: 100n, currency: 'LKR' }] } }, include: { postings: true } });
      await expect(db.ledgerPosting.update({ where: { id: j.postings[0]!.id }, data: { amountMinor: 999n } })).rejects.toThrow(); // postings are immutable
      await expect(db.ledgerPosting.delete({ where: { id: j.postings[0]!.id } })).rejects.toThrow();
      await expect(db.ledgerPosting.create({ data: { journalId: j.id, ledgerAccountId: acct.id, direction: 'CREDIT', amountMinor: 0n, currency: 'LKR' } })).rejects.toThrow(); // amount must be positive
    } finally {
      await db.$disconnect();
    }
  }, 240_000);
});
