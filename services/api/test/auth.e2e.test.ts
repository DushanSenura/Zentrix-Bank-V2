import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

try {
  process.loadEnvFile('../../.env');
} catch {
  /* CI provides env */
}
const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB; // never run against the dev database

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { encrypt } from '../src/security/crypto';
import { hashSecret } from '../src/security/password';
import { PERMISSIONS, ROLE_GRANTS } from '../src/security/rbac';
import { newTotpSecret, totpNow } from '../src/security/totp';

const PW = 'Str0ngPassw0rd!x';
const run = Math.random().toString(36).slice(2, 8);
const u = (n: string) => `${n}_${run}`;

describe.skipIf(!TEST_DB)('auth, RBAC and KYC (real database)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const prisma = new PrismaClient();
  const key = () => Buffer.from(process.env.DATA_ENCRYPTION_KEY!, 'base64');

  async function seedRbac() {
    for (const [k, description] of Object.entries(PERMISSIONS)) await prisma.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description } });
    for (const [k, g] of Object.entries(ROLE_GRANTS)) {
      const role = await prisma.role.upsert({ where: { key: k }, update: {}, create: { key: k, name: g.name, system: true } });
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      const perms = await prisma.permission.findMany({ where: { key: { in: g.permissions } } });
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
  }
  async function makeStaff(name: string, role: string) {
    const totp = newTotpSecret();
    const user = await prisma.user.create({
      data: {
        type: 'STAFF', username: u(name), email: `${u(name)}@t.test`, status: 'ACTIVE', passwordHash: await hashSecret(PW), mfaSecretEnc: encrypt(totp, key()),
        staff: { create: { employeeNo: `E-${u(name)}`, fullName: name } },
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { key: role } })).id } });
    return { id: user.id, username: u(name), totp };
  }
  const staffLogin = async (s: { username: string; totp: string }) =>
    (await http.post('/api/v1/auth/login').send({ identifier: s.username, password: PW, mfaCode: totpNow(s.totp) })).body.accessToken as string;
  const register = (name: string) =>
    http.post('/api/v1/auth/register').send({ fullName: 'Test Person', username: u(name), email: `${u(name)}@t.test`, password: PW });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    await seedRbac();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it('registers a customer (never staff) and rejects weak/duplicate input', async () => {
    const res = await http.post('/api/v1/auth/register').send({ fullName: 'Test Person', username: u('reg'), email: `${u('reg')}@t.test`, password: PW, type: 'STAFF' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { username: u('reg') } })).type).toBe('CUSTOMER');
    expect((await http.post('/api/v1/auth/register').send({ fullName: 'Weak One', username: u('weak'), email: `${u('weak')}@t.test`, password: 'short' })).status).toBe(400);
    expect((await register('reg')).status).toBe(409);
  });

  it('gives identical errors for unknown user and wrong password; locks after 5 failures', async () => {
    await register('lock');
    const wrong = await http.post('/api/v1/auth/login').send({ identifier: u('lock'), password: 'Wrong-pass-123' });
    const unknown = await http.post('/api/v1/auth/login').send({ identifier: u('nobody'), password: 'Wrong-pass-123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe(unknown.body.code);
    expect(wrong.body.message).toBe(unknown.body.message);
    for (let i = 0; i < 4; i++) await http.post('/api/v1/auth/login').send({ identifier: u('lock'), password: 'Wrong-pass-123' });
    // now locked: even the correct password is refused
    expect((await http.post('/api/v1/auth/login').send({ identifier: u('lock'), password: PW })).status).toBe(401);
    expect(await prisma.securityEvent.count({ where: { kind: 'ACCOUNT_LOCKED', user: { username: u('lock') } } })).toBe(1);
  });

  it('rotates refresh tokens, detects reuse and revokes; logout revokes access', async () => {
    const reg = (await register('ref')).body;
    const r1 = await http.post('/api/v1/auth/refresh').send({ refreshToken: reg.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(reg.refreshToken);
    // replaying the old token = theft signal: refused AND the session dies
    expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: reg.refreshToken })).status).toBe(401);
    expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
    expect((await http.get('/api/v1/me').set('Authorization', `Bearer ${r1.body.accessToken}`)).status).toBe(401);

    const login = (await http.post('/api/v1/auth/login').send({ identifier: u('ref'), password: PW })).body;
    expect((await http.get('/api/v1/me').set('Authorization', `Bearer ${login.accessToken}`)).status).toBe(200);
    expect((await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${login.accessToken}`)).status).toBe(204);
    expect((await http.get('/api/v1/me').set('Authorization', `Bearer ${login.accessToken}`)).status).toBe(401);
  });

  it('requires authentication by default and rejects tampered tokens', async () => {
    expect((await http.get('/api/v1/me')).status).toBe(401);
    const t = (await register('tamper')).body.accessToken as string;
    expect((await http.get('/api/v1/me').set('Authorization', `Bearer ${t.slice(0, -3)}abc`)).status).toBe(401);
  });

  it('enforces mandatory MFA for staff', async () => {
    const s = await makeStaff('mfa', 'ACCOUNT_OFFICER');
    const noCode = await http.post('/api/v1/auth/login').send({ identifier: s.username, password: PW });
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('mfa_required');
    expect((await http.post('/api/v1/auth/login').send({ identifier: s.username, password: PW, mfaCode: '000000' })).status).toBe(401);
    expect((await http.post('/api/v1/auth/login').send({ identifier: s.username, password: PW, mfaCode: totpNow(s.totp) })).status).toBe(200);
  });

  it('Scenario A: register -> KYC -> staff review -> approve -> customer active (with RBAC + audit)', async () => {
    const cust = (await register('kyc')).body;
    const auth = { Authorization: `Bearer ${cust.accessToken}` };
    expect((await http.get('/api/v1/me').set(auth)).body.status).toBe('PENDING_VERIFICATION');
    expect((await http.post('/api/v1/me/kyc').set(auth).send({ nationalId: '199012345678', dateOfBirth: '2015-01-01', address: { line1: '1 Test Rd', city: 'Colombo', postalCode: '00100' } })).status).toBe(400); // under 18
    const sub = await http.post('/api/v1/me/kyc').set(auth).send({ nationalId: '199012345678', dateOfBirth: '1990-05-05', address: { line1: '1 Test Rd', city: 'Colombo', postalCode: '00100' } });
    expect(sub.status).toBe(201);
    expect((await http.post('/api/v1/me/kyc').set(auth).send({ nationalId: '199012345678', dateOfBirth: '1990-05-05', address: { line1: '1 Test Rd', city: 'Colombo', postalCode: '00100' } })).status).toBe(409);

    // customer cannot use admin endpoints -> 403 + security event (Scenario G)
    expect((await http.get('/api/v1/admin/kyc').set(auth)).status).toBe(403);
    const me = await prisma.user.findUniqueOrThrow({ where: { username: u('kyc') } });
    expect(await prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_ENDPOINT_ACCESS', userId: me.id } })).toBeGreaterThan(0);

    // staff without kyc.review is refused
    const auditor = await makeStaff('auditor', 'AUDITOR');
    expect((await http.get('/api/v1/admin/kyc').set('Authorization', `Bearer ${await staffLogin(auditor)}`)).status).toBe(403);

    const officer = await makeStaff('officer', 'ACCOUNT_OFFICER');
    const sAuth = { Authorization: `Bearer ${await staffLogin(officer)}` };
    const queue = await http.get('/api/v1/admin/kyc').set(sAuth);
    const item = queue.body.items.find((i: { userId: string }) => i.userId === me.id);
    expect(item.nationalIdMasked).toBe('********5678'); // never the full ID
    expect(JSON.stringify(queue.body)).not.toContain('199012345678');

    expect((await http.post(`/api/v1/admin/kyc/${me.id}/decision`).set(sAuth).send({ decision: 'REJECT' })).status).toBe(400); // reason required
    expect((await http.post(`/api/v1/admin/kyc/${me.id}/decision`).set(sAuth).send({ decision: 'APPROVE' })).status).toBe(201);
    expect((await http.post(`/api/v1/admin/kyc/${me.id}/decision`).set(sAuth).send({ decision: 'APPROVE' })).status).toBe(409); // not re-decidable

    const after = (await http.get('/api/v1/me').set(auth)).body;
    expect(after.status).toBe('ACTIVE');
    expect(after.kycStatus).toBe('APPROVED');
    expect(await prisma.auditLog.count({ where: { action: 'kyc.approve', subjectId: me.id, actorId: officer.id } })).toBe(1);
  });

  it('password reset is single-use, never reveals accounts, and revokes sessions', async () => {
    const reg = (await register('reset')).body;
    expect((await http.post('/api/v1/auth/password-reset/request').send({ identifier: u('ghost') })).status).toBe(202);
    expect((await http.post('/api/v1/auth/password-reset/request').send({ identifier: u('reset') })).status).toBe(202);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: u('reset') } });
    const ev = (await prisma.outboxEvent.findMany({ where: { topic: 'auth.password_reset_requested' }, orderBy: { createdAt: 'desc' } })).find(
      (e) => (e.payload as { userId?: string }).userId === user.id,
    );
    const code = (ev!.payload as { devCode: string }).devCode;
    expect(code).toMatch(/^\d{6}$/);
    const identifier = u('reset');
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await http.post('/api/v1/auth/password-reset/confirm').send({ identifier, code: wrong, newPassword: 'An0therStr0ng!pw' })).status).toBe(401);
    const NEW = 'An0therStr0ng!pw';
    expect((await http.post('/api/v1/auth/password-reset/confirm').send({ identifier, code, newPassword: 'weak' })).status).toBe(400);
    expect((await http.post('/api/v1/auth/password-reset/confirm').send({ identifier, code, newPassword: NEW })).status).toBe(204);
    expect((await http.post('/api/v1/auth/password-reset/confirm').send({ identifier, code, newPassword: NEW })).status).toBe(401); // single use
    expect((await http.get('/api/v1/me').set('Authorization', `Bearer ${reg.accessToken}`)).status).toBe(401); // old session revoked
    expect((await http.post('/api/v1/auth/login').send({ identifier: u('reset'), password: PW })).status).toBe(401);
    expect((await http.post('/api/v1/auth/login').send({ identifier: u('reset'), password: NEW })).status).toBe(200);
  });

  it('validates the app PIN server-side and stores only a hash', async () => {
    const t = (await register('pin')).body.accessToken as string;
    const auth = { Authorization: `Bearer ${t}` };
    expect((await http.put('/api/v1/me/pin').set(auth).send({ pin: '1111' })).status).toBe(400);
    expect((await http.put('/api/v1/me/pin').set(auth).send({ pin: '1234' })).status).toBe(400);
    expect((await http.put('/api/v1/me/pin').set(auth).send({ pin: '482916' })).status).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { username: u('pin') } });
    expect(row.pinHash).toMatch(/^\$argon2id\$/);
    expect(row.pinHash).not.toContain('482916');
    expect((await http.get('/api/v1/me').set(auth)).body.hasPin).toBe(true);
  });
});
