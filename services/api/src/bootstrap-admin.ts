/**
 * Creates the FIRST Super Administrator for a fresh environment (staging, or any other non-development setup).
 *
 *   node dist/bootstrap-admin.js --username ops.admin --email ops@example.test --name "Ops Admin" --out /secure/path/setup.json
 *
 * The one-time setup token is written to --out with owner-only permissions and is NEVER printed. The new admin opens the
 * admin portal's setup page with it, chooses a password, and enrols an authenticator app (setup tokens are single-use and
 * expire after 72 hours). Refuses to run if an active Super Administrator already exists, unless --additional is given
 * (an operator with database access creating a recovery admin; it is audited).
 */
import { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { randomToken, sha256 } from './security/crypto';
import { hashSecret } from './security/password';

const SETUP_TTL_MS = 72 * 3_600_000;

export interface BootstrapInput { username: string; email: string; fullName: string; additional?: boolean }
export interface BootstrapResult { userId: string; username: string; token: string; expiresAt: Date }

/**
 * `deliver` receives the token INSIDE the database transaction, before it commits. If delivery fails (unwritable path, full disk)
 * the whole transaction rolls back, so an administrator can never exist without their setup token having been handed over.
 */
export async function bootstrapSuperAdmin(prisma: PrismaClient, i: BootstrapInput, deliver?: (r: BootstrapResult) => void): Promise<BootstrapResult> {
  const username = i.username.trim().toLowerCase();
  const email = i.email.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('username must be 3-32 characters: letters, digits, dot, dash or underscore');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email is not valid');
  if (i.fullName.trim().length < 2) throw new Error('name is required');
  const role = await prisma.role.findUnique({ where: { key: 'SUPER_ADMIN' } });
  if (!role) throw new Error('RBAC is not seeded. Run the seed (node dist/seed.js) first.');
  const existing = await prisma.user.count({ where: { type: 'STAFF', status: 'ACTIVE', staff: { active: true }, roles: { some: { roleId: role.id } } } });
  if (existing > 0 && !i.additional) throw new Error('An active Super Administrator already exists. Use the admin portal to invite staff (or pass --additional for an audited recovery admin).');
  if (await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } })) throw new Error('That username or email is already in use');

  const token = randomToken();
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      // Nobody knows this password: the account cannot be used until the setup token is redeemed.
      data: { type: 'STAFF', username, email, status: 'ACTIVE', passwordHash: await hashSecret(randomToken(48)), staff: { create: { employeeNo: `EMP-${String(randomInt(0, 1e8)).padStart(8, '0')}`, fullName: i.fullName.trim() } } },
    });
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } });
    await tx.authenticationChallenge.create({ data: { userId: u.id, purpose: 'STAFF_SETUP', tokenHash: sha256(token), expiresAt } });
    await tx.auditLog.create({ data: { actorType: 'SYSTEM', action: 'staff.bootstrapped', subjectType: 'User', subjectId: u.id, metadata: { additional: !!i.additional } } });
    const result = { userId: u.id, username, token, expiresAt };
    deliver?.(result);
    return u;
  });
  return { userId: user.id, username, token, expiresAt };
}

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const out = arg('out');
  const username = arg('username'), email = arg('email'), fullName = arg('name');
  if (!out || !username || !email || !fullName) { console.error('Usage: bootstrap-admin --username <u> --email <e> --name "<full name>" --out <file> [--additional]'); process.exit(2); }
  if (existsSync(out)) { console.error(`Refusing to overwrite ${out}`); process.exit(2); }
  const prisma = new PrismaClient();
  try {
    const r = await bootstrapSuperAdmin(prisma, { username, email, fullName, additional: process.argv.includes('--additional') }, (x) => {
      // 'wx' fails if the file appeared since the check above; any failure here rolls the new administrator back.
      writeFileSync(out, JSON.stringify({ username: x.username, setupToken: x.token, expiresAt: x.expiresAt.toISOString(), note: 'Single use. Open the admin portal setup page, choose a password and enrol an authenticator app. Delete this file afterwards.' }, null, 2), { mode: 0o600, flag: 'wx' });
      try { chmodSync(out, 0o600); } catch { /* not supported on this filesystem */ }
    });
    console.log(`Created Super Administrator "${r.username}". Setup token written to ${out} (not shown here). It expires ${r.expiresAt.toISOString()}.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'failed');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
