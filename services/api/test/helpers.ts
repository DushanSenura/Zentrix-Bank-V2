import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';

try {
  process.loadEnvFile('../../.env');
} catch {
  /* CI provides env */
}
export const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB; // never run against the dev database

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { encrypt } from '../src/security/crypto';
import { hashSecret } from '../src/security/password';
import { PERMISSIONS, ROLE_GRANTS } from '../src/security/rbac';
import { newTotpSecret, totpNow } from '../src/security/totp';

export const PW = 'Str0ngPassw0rd!x';
export const run = Math.random().toString(36).slice(2, 8);
export const u = (n: string) => `${n.toLowerCase()}_${run}`; // logins are case-insensitive (lower-cased)
export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export interface Ctx {
  app: INestApplication;
  http: ReturnType<typeof request>;
  prisma: PrismaClient;
}

export async function boot(): Promise<Ctx> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  const prisma = new PrismaClient();
  await seedRbac(prisma);
  await seedProducts(prisma);
  await seedFdRates(prisma);
  return { app, http: request(app.getHttpServer()), prisma };
}

export async function seedRbac(prisma: PrismaClient) {
  for (const [k, description] of Object.entries(PERMISSIONS)) await prisma.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description } });
  for (const [k, g] of Object.entries(ROLE_GRANTS)) {
    const role = await prisma.role.upsert({ where: { key: k }, update: {}, create: { key: k, name: g.name, system: true } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const perms = await prisma.permission.findMany({ where: { key: { in: g.permissions } } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  }
}

export async function seedProducts(prisma: PrismaClient) {
  await prisma.accountProduct.upsert({ where: { code: 'SAVINGS_STD' }, update: {}, create: { code: 'SAVINGS_STD', name: 'Savings Account', kind: 'SAVINGS', minOpeningMinor: 100000n, interestRateBps: 350 } });
  await prisma.accountProduct.upsert({ where: { code: 'CURRENT_STD' }, update: {}, create: { code: 'CURRENT_STD', name: 'Current Account', kind: 'CURRENT', minOpeningMinor: 100000n } });
}

export async function seedFdRates(prisma: PrismaClient) {
  const { DEFAULT_RATES } = await import('../src/modules/deposits/deposits.service');
  for (const r of DEFAULT_RATES) await prisma.fixedDepositRate.upsert({ where: { termMonths: r.termMonths }, update: {}, create: { termMonths: r.termMonths, rateBps: r.rateBps } });
}

export async function makeStaff(ctx: Ctx, name: string, role: string) {
  const totp = newTotpSecret();
  const key = Buffer.from(process.env.DATA_ENCRYPTION_KEY!, 'base64');
  const user = await ctx.prisma.user.create({
    data: { type: 'STAFF', username: u(name), email: `${u(name)}@t.test`, status: 'ACTIVE', passwordHash: await hashSecret(PW), mfaSecretEnc: encrypt(totp, key), staff: { create: { employeeNo: `E-${u(name)}`, fullName: name } } },
  });
  await ctx.prisma.userRole.create({ data: { userId: user.id, roleId: (await ctx.prisma.role.findUniqueOrThrow({ where: { key: role } })).id } });
  const login = await ctx.http.post('/api/v1/auth/login').send({ identifier: u(name), password: PW, mfaCode: totpNow(totp) });
  return { id: user.id, token: login.body.accessToken as string };
}

/** A verified, ACTIVE customer (as if KYC had been approved) with a live session. */
export async function makeCustomer(ctx: Ctx, name: string, opts: { active?: boolean } = {}) {
  const active = opts.active ?? true;
  const user = await ctx.prisma.user.create({
    data: {
      type: 'CUSTOMER', username: u(name), email: `${u(name)}@t.test`, status: active ? 'ACTIVE' : 'PENDING_VERIFICATION', passwordHash: await hashSecret(PW),
      customer: { create: { customerNumber: `ZB${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`, fullName: `Customer ${name}`, kycStatus: active ? 'APPROVED' : 'NOT_SUBMITTED' } },
    },
  });
  const login = await ctx.http.post('/api/v1/auth/login').send({ identifier: u(name), password: PW });
  return { id: user.id, token: login.body.accessToken as string };
}

/** Creates a customer account + ledger account directly (bypassing the approval workflow) and funds it from the cash account. */
export async function makeLedgerAccount(ctx: Ctx, customerId: string, opening = 0n, overdraft = false) {
  const product = await ctx.prisma.accountProduct.findUniqueOrThrow({ where: { code: 'SAVINGS_STD' } });
  const n = `9${Math.floor(Math.random() * 1e10).toString().padStart(10, '0')}`;
  return ctx.prisma.account.create({
    data: { customerId, productId: product.id, accountNumber: n, ledgerAccount: { create: { code: `ACC-${n}`, name: n, type: 'LIABILITY', currency: 'LKR', allowNegative: overdraft, balanceMinor: 0n } } },
    include: { ledgerAccount: true },
  }).then(async (a) => {
    if (opening > 0n) {
      const { LedgerService } = await import('../src/modules/ledger/ledger.service');
      const ledger = ctx.app.get(LedgerService);
      await ledger.post({ reference: `T-OPEN-${n}`, kind: 'TEST_FUNDING', currency: 'LKR', postings: [
        { ledgerAccountId: await ledger.systemAccountId('cash'), direction: 'DEBIT', amountMinor: opening, currency: 'LKR' },
        { ledgerAccountId: a.ledgerAccount!.id, direction: 'CREDIT', amountMinor: opening, currency: 'LKR' },
      ] });
    }
    return a;
  });
}

export const PIN = '482916';

/** A verified customer with an app PIN and one funded account (everything a money-moving test needs). */
export async function makePayer(ctx: Ctx, name: string, balance: bigint) {
  const c = await makeCustomer(ctx, name);
  const set = await ctx.http.put('/api/v1/me/pin').set(bearer(c.token)).send({ pin: PIN });
  if (set.status !== 204) throw new Error(`PIN setup failed: ${set.status}`);
  const acc = await makeLedgerAccount(ctx, c.id, balance);
  return { ...c, acc, accountId: acc.id, number: acc.accountNumber, ledgerId: acc.ledgerAccount!.id };
}
export type Payer = Awaited<ReturnType<typeof makePayer>>;
