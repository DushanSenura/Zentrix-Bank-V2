/**
 * Development seed (idempotent). Seeds the RBAC catalogue always; creates fictional demo users only when
 * APP_ENV=development. Passwords and the staff TOTP secret are generated randomly and written to
 * <repo>/.local-dev-credentials.json (git-ignored) - never printed, never committed, no fixed defaults.
 *   pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadEnv } from './config/env';
import { encrypt } from './security/crypto';
import { hashSecret } from './security/password';
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
  await ensureUser({ username: 'amaya.demo', email: 'amaya.demo@zentrix.test', type: 'CUSTOMER', fullName: 'Amaya Perera (fictional)', status: 'ACTIVE', kyc: 'APPROVED', customerNumber: 'ZB90000001' });
  await ensureUser({ username: 'nuwan.demo', email: 'nuwan.demo@zentrix.test', type: 'CUSTOMER', fullName: 'Nuwan Silva (fictional)', status: 'PENDING_VERIFICATION', kyc: 'SUBMITTED', customerNumber: 'ZB90000002' });

  if (Object.keys(creds).length > 1) {
    writeFileSync('../../.local-dev-credentials.json', JSON.stringify(creds, null, 2));
    console.log('Credentials written to .local-dev-credentials.json (git-ignored).');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
