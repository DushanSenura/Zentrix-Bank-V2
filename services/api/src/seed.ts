/**
 * Development seed (idempotent). Seeds the RBAC catalogue always; creates fictional demo users only when
 * APP_ENV=development. Passwords and the staff TOTP secret are generated randomly and written to
 * <repo>/.local-dev-credentials.json (git-ignored) - never printed, never committed, no fixed defaults.
 *   pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv } from './config/env';
import { encrypt } from './security/crypto';
import { hashSecret, pinProblem } from './security/password';
import { DEFAULT_RATES } from './modules/deposits/deposits.service';
import { DEFAULT_MID_MICRO } from './modules/fx/fx.service';
import { DEFAULT_LOAN_PRODUCTS } from './modules/loans/loans.service';
import { LedgerService } from './modules/ledger/ledger.service';
import { PrismaService } from './common/prisma.service';
import { PERMISSIONS, ROLE_GRANTS } from './security/rbac';
import { newTotpSecret, totpUri } from './security/totp';

try {
  process.loadEnvFile('../../.env');
} catch {
  /* rely on process env */
}

const pw = () => `Zx${randomBytes(9).toString('base64url')}9a`;

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');

  for (const [k, description] of Object.entries(PERMISSIONS))
    await prisma.permission.upsert({ where: { key: k }, update: { description }, create: { key: k, description } });
  for (const [k, g] of Object.entries(ROLE_GRANTS)) {
    const role = await prisma.role.upsert({ where: { key: k }, update: { name: g.name }, create: { key: k, name: g.name, system: true } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const perms = await prisma.permission.findMany({ where: { key: { in: g.permissions } } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  }
  // Account products (bank-configurable defaults carried over from V1: LKR 1,000 minimum opening deposit).
  await prisma.accountProduct.upsert({ where: { code: 'SAVINGS_STD' }, update: {}, create: { code: 'SAVINGS_STD', name: 'Savings Account', kind: 'SAVINGS', minOpeningMinor: 100000n, interestRateBps: 350 } });
  await prisma.accountProduct.upsert({ where: { code: 'CURRENT_STD' }, update: {}, create: { code: 'CURRENT_STD', name: 'Current Account', kind: 'CURRENT', minOpeningMinor: 100000n } });
  // Foreign-currency accounts open with no deposit (they are funded by exchanging rupees) and start with fictional mid rates.
  for (const [cur, name] of [['USD', 'US Dollar Account'], ['EUR', 'Euro Account'], ['GBP', 'Pound Sterling Account']] as const)
    await prisma.accountProduct.upsert({ where: { code: `FX_${cur}` }, update: {}, create: { code: `FX_${cur}`, name, kind: 'FOREIGN_CURRENCY', currency: cur, minOpeningMinor: 0n } });
  for (const [cur, micro] of Object.entries(DEFAULT_MID_MICRO)) await prisma.fxRate.upsert({ where: { currency: cur }, update: {}, create: { currency: cur, midRateMicro: micro } });
  // Fixed-deposit rate card (sample figures), loan products (sample) and a few fictional branches/ATMs.
  for (const r of DEFAULT_RATES) await prisma.fixedDepositRate.upsert({ where: { termMonths: r.termMonths }, update: {}, create: { termMonths: r.termMonths, rateBps: r.rateBps } });
  for (const p of DEFAULT_LOAN_PRODUCTS) await prisma.loanProduct.upsert({ where: { code: p.code }, update: {}, create: p });
  const branches = [
    { code: 'COL-FORT', name: 'Colombo Fort', city: 'Colombo', address: '1 Sample Street, Fort', type: 'BRANCH', latitude: 6.9344, longitude: 79.8428 },
    { code: 'KDY-MAIN', name: 'Kandy City', city: 'Kandy', address: '22 Sample Road', type: 'BRANCH', latitude: 7.2906, longitude: 80.6337 },
    { code: 'GLE-MAIN', name: 'Galle', city: 'Galle', address: '5 Sample Lane', type: 'BRANCH', latitude: 6.0535, longitude: 80.221 },
    { code: 'COL-ATM1', name: 'Colombo Fort ATM', city: 'Colombo', address: 'Fort Railway Station', type: 'ATM', latitude: 6.9335, longitude: 79.85 },
  ];
  for (const b of branches) await prisma.branch.upsert({ where: { code: b.code }, update: {}, create: b });
  console.log(`RBAC seeded: ${Object.keys(PERMISSIONS).length} permissions, ${Object.keys(ROLE_GRANTS).length} roles`);

  if (env.APP_ENV !== 'development') {
    console.log('Non-development environment: demo users NOT created. Provision staff through the controlled process.');
    return prisma.$disconnect();
  }

  const creds: Record<string, unknown> = { note: 'Local development only. Fictional people. Delete this file when done.' };

  async function ensureUser(opts: {
    username: string; email: string; type: 'CUSTOMER' | 'STAFF'; fullName: string; status: 'ACTIVE' | 'PENDING_VERIFICATION';
    role?: string; kyc?: 'APPROVED' | 'SUBMITTED'; customerNumber?: string;
  }) {
    if (await prisma.user.findUnique({ where: { username: opts.username } })) {
      console.log(`exists: ${opts.username} (credentials unchanged; delete the user to regenerate)`);
      return;
    }
    const password = pw();
    const secret = opts.type === 'STAFF' ? newTotpSecret() : undefined;
    const user = await prisma.user.create({
      data: {
        type: opts.type, username: opts.username, email: opts.email, status: opts.status,
        passwordHash: await hashSecret(password),
        mfaSecretEnc: secret ? encrypt(secret, key) : null,
        ...(opts.type === 'CUSTOMER'
          ? { customer: { create: { customerNumber: opts.customerNumber!, fullName: opts.fullName, kycStatus: opts.kyc ?? 'NOT_SUBMITTED' } } }
          : { staff: { create: { employeeNo: `EMP-${opts.username.toUpperCase()}`, fullName: opts.fullName } } }),
      },
    });
    if (opts.role) {
      const role = await prisma.role.findUniqueOrThrow({ where: { key: opts.role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    creds[opts.username] = { password, ...(secret ? { totpSecretBase32: secret, otpauth: totpUri(secret, opts.username) } : {}) };
    console.log(`created: ${opts.username}`);
  }

  await ensureUser({ username: 'admin.demo', email: 'admin.demo@zentrix.test', type: 'STAFF', fullName: 'Demo Administrator', status: 'ACTIVE', role: 'SUPER_ADMIN' });
  await ensureUser({ username: 'kyc.officer.demo', email: 'kyc.demo@zentrix.test', type: 'STAFF', fullName: 'Demo Account Officer', status: 'ACTIVE', role: 'ACCOUNT_OFFICER' });
  // One fictional staff member per remaining role, so every role's view of the portal can be tried.
  const demoStaff: [string, string, string][] = [
    ['bank.admin.demo', 'BANK_ADMIN', 'Demo Bank Administrator'], ['branch.manager.demo', 'BRANCH_MANAGER', 'Demo Branch Manager'],
    ['operations.demo', 'OPERATIONS_OFFICER', 'Demo Operations Officer'], ['support.demo', 'CUSTOMER_SERVICE', 'Demo Customer Service Officer'],
    ['loan.officer.demo', 'LOAN_OFFICER', 'Demo Loan Officer'], ['card.officer.demo', 'CARD_OFFICER', 'Demo Card Officer'],
    ['compliance.demo', 'COMPLIANCE_OFFICER', 'Demo Compliance Officer'], ['auditor.demo', 'AUDITOR', 'Demo Auditor'],
  ];
  for (const [username, role, fullName] of demoStaff) await ensureUser({ username, email: `${username}@zentrix.test`, type: 'STAFF', fullName, status: 'ACTIVE', role });
  await ensureUser({ username: 'amaya.demo', email: 'amaya.demo@zentrix.test', type: 'CUSTOMER', fullName: 'Amaya Perera (fictional)', status: 'ACTIVE', kyc: 'APPROVED', customerNumber: 'ZB90000001' });
  await ensureUser({ username: 'kamal.demo', email: 'kamal.demo@zentrix.test', type: 'CUSTOMER', fullName: 'Kamal Fernando (fictional)', status: 'ACTIVE', kyc: 'APPROVED', customerNumber: 'ZB90000003' });
  await ensureUser({ username: 'nuwan.demo', email: 'nuwan.demo@zentrix.test', type: 'CUSTOMER', fullName: 'Nuwan Silva (fictional)', status: 'PENDING_VERIFICATION', kyc: 'SUBMITTED', customerNumber: 'ZB90000002' });

  // Fictional demo money for amaya.demo: one funded savings account (via the ledger) and one pending application.
  const amaya = await prisma.user.findUnique({ where: { username: 'amaya.demo' } });
  if (amaya && (await prisma.account.count({ where: { customerId: amaya.id } })) === 0) {
    const product = await prisma.accountProduct.findUniqueOrThrow({ where: { code: 'SAVINGS_STD' } });
    const n = '10000000001';
    const acc = await prisma.account.create({
      data: { customerId: amaya.id, productId: product.id, accountNumber: n, nickname: 'Main savings', ledgerAccount: { create: { code: `ACC-${n}`, name: `Customer account ${n}`, type: 'LIABILITY', currency: 'LKR' } }, statusHistory: { create: { toStatus: 'ACTIVE', reasonCode: 'DEMO_SEED' } } },
      include: { ledgerAccount: true },
    });
    const svc = new PrismaService();
    await svc.$connect();
    const ledger = new LedgerService(svc);
    await ledger.post({ reference: 'DEMO-OPEN-10000000001', kind: 'ACCOUNT_OPENING', currency: 'LKR', description: 'Opening deposit (demo)', postings: [
      { ledgerAccountId: await ledger.systemAccountId('cash'), direction: 'DEBIT', amountMinor: 5_000_000n, currency: 'LKR' },
      { ledgerAccountId: acc.ledgerAccount!.id, direction: 'CREDIT', amountMinor: 5_000_000n, currency: 'LKR' } ] });
    await svc.$disconnect();
    const cur = await prisma.accountProduct.findUniqueOrThrow({ where: { code: 'CURRENT_STD' } });
    await prisma.accountApplication.create({ data: { customerId: amaya.id, productId: cur.id, requestedNickname: 'Bills' } });
    console.log('demo account + pending application created for amaya.demo');
  }

  // Kamal gets a funded account too, so the demo customers can pay each other.
  const kamal = await prisma.user.findUnique({ where: { username: 'kamal.demo' } });
  if (kamal && (await prisma.account.count({ where: { customerId: kamal.id } })) === 0) {
    const product = await prisma.accountProduct.findUniqueOrThrow({ where: { code: 'SAVINGS_STD' } });
    const n = '10000000002';
    const acc = await prisma.account.create({
      data: { customerId: kamal.id, productId: product.id, accountNumber: n, nickname: 'Everyday', ledgerAccount: { create: { code: `ACC-${n}`, name: `Customer account ${n}`, type: 'LIABILITY', currency: 'LKR' } } },
      include: { ledgerAccount: true },
    });
    const svc = new PrismaService();
    await svc.$connect();
    const ledger = new LedgerService(svc);
    await ledger.post({ reference: `DEMO-OPEN-${n}`, kind: 'ACCOUNT_OPENING', currency: 'LKR', description: 'Opening deposit (demo)', postings: [
      { ledgerAccountId: await ledger.systemAccountId('cash'), direction: 'DEBIT', amountMinor: 2_500_000n, currency: 'LKR' },
      { ledgerAccountId: acc.ledgerAccount!.id, direction: 'CREDIT', amountMinor: 2_500_000n, currency: 'LKR' } ] });
    await svc.$disconnect();
    console.log('demo account created for kamal.demo');
  }

  // The two active demo customers get an app PIN (random, kept only in the git-ignored credentials file) so payments can be tried.
  for (const username of ['amaya.demo', 'kamal.demo']) {
    const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    const known = existsSync('../../.local-dev-credentials.json') ? (JSON.parse(readFileSync('../../.local-dev-credentials.json', 'utf8')) as Record<string, { pin?: string }>)[username]?.pin : undefined;
    if (!u || known) continue; // a demo customer whose PIN we do not know (for example set by hand earlier) gets a fresh one: this is demo data only
    let pin = '';
    do { pin = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (pinProblem(pin));
    await prisma.user.update({ where: { id: u.id }, data: { pinHash: await hashSecret(pin), pinSetAt: new Date() } });
    creds[username] = { ...((creds[username] as object) ?? {}), pin };
    console.log(`app PIN set for ${username}`);
  }

  if (Object.keys(creds).length > 1) {
    // Merge with what is already there: users that already existed keep their credentials, and re-running must not erase them.
    const file = '../../.local-dev-credentials.json';
    const previous = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...previous };
    for (const [k, v] of Object.entries(creds)) merged[k] = typeof v === 'object' && v && typeof merged[k] === 'object' ? { ...(merged[k] as object), ...v } : v;
    writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
    console.log('Credentials written to .local-dev-credentials.json (git-ignored).');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
