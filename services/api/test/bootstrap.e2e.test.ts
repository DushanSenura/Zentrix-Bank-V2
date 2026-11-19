import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapSuperAdmin } from '../src/bootstrap-admin';
import { boot, makeStaff, TEST_DB, type Ctx } from './helpers';

describe.skipIf(!TEST_DB)('first Super Administrator bootstrap', () => {
  let ctx: Ctx;
  const id = randomBytes(3).toString('hex');
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  it('refuses to create a second Super Administrator unless explicitly told to', async () => {
    await makeStaff(ctx, `existing${id}`, 'SUPER_ADMIN');
    await expect(bootstrapSuperAdmin(ctx.prisma, { username: `ops${id}`, email: `ops${id}@example.test`, fullName: 'Ops Admin' })).rejects.toThrow(/already exists/);
    expect(await ctx.prisma.user.count({ where: { username: `ops${id}` } })).toBe(0);
  });

  it('validates its input', async () => {
    await expect(bootstrapSuperAdmin(ctx.prisma, { username: 'x', email: 'a@b.test', fullName: 'Ok Name', additional: true })).rejects.toThrow(/username/);
    await expect(bootstrapSuperAdmin(ctx.prisma, { username: `good${id}`, email: 'not-an-email', fullName: 'Ok Name', additional: true })).rejects.toThrow(/email/);
    await expect(bootstrapSuperAdmin(ctx.prisma, { username: `good${id}`, email: `g${id}@example.test`, fullName: ' ', additional: true })).rejects.toThrow(/name/);
  });

  it('creates an admin who cannot sign in until the single-use token is redeemed, then must enrol MFA', async () => {
    const r = await bootstrapSuperAdmin(ctx.prisma, { username: `ops${id}`, email: `ops${id}@example.test`, fullName: 'Ops Admin', additional: true });
    expect(r.token.length).toBeGreaterThanOrEqual(32);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: r.userId }, include: { roles: { include: { role: true } } } });
    expect(row.roles.map((x) => x.role.key)).toEqual(['SUPER_ADMIN']);
    expect(row.mfaSecretEnc).toBeNull();
    // The token is stored only as a hash.
    const ch = await ctx.prisma.authenticationChallenge.findFirstOrThrow({ where: { userId: r.userId } });
    expect(ch.tokenHash).not.toContain(r.token);
    expect(await ctx.prisma.auditLog.count({ where: { subjectId: r.userId, action: 'staff.bootstrapped' } })).toBe(1);

    // No password can sign in yet.
    const early = await ctx.http.post('/api/v1/auth/login').send({ identifier: `ops${id}`, password: 'Anything-Goes-1!x' });
    expect(early.status).toBe(401);

    expect((await ctx.http.post('/api/v1/auth/staff-setup').send({ token: 'f'.repeat(43), password: 'Violet-Harbor-Lamp-7!q' })).status).toBe(401);
    expect((await ctx.http.post('/api/v1/auth/staff-setup').send({ token: r.token, password: 'short' })).status).toBe(400); // weak password does not burn the token
    const ok = await ctx.http.post('/api/v1/auth/staff-setup').send({ token: r.token, password: 'Violet-Harbor-Lamp-7!q' });
    expect(ok.status).toBe(200);
    expect(ok.body.secret).toBeTruthy(); // authenticator secret shown once
    expect((await ctx.http.post('/api/v1/auth/staff-setup').send({ token: r.token, password: 'Violet-Harbor-Lamp-7!q' })).status).toBe(401); // single use

    const noMfa = await ctx.http.post('/api/v1/auth/login').send({ identifier: `ops${id}`, password: 'Violet-Harbor-Lamp-7!q' });
    expect(noMfa.status).toBeGreaterThanOrEqual(400); // staff must present a one-time code
    expect(noMfa.body.accessToken).toBeUndefined();
  });

  it('rolls everything back if the token cannot be handed over (no admin without a token)', async () => {
    await expect(bootstrapSuperAdmin(ctx.prisma, { username: `lost${id}`, email: `lost${id}@example.test`, fullName: 'Lost Token', additional: true }, () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(await ctx.prisma.user.count({ where: { username: `lost${id}` } })).toBe(0);
    expect(await ctx.prisma.authenticationChallenge.count({ where: { user: { username: `lost${id}` } } })).toBe(0);
  });

  it('rejects a duplicate username or email', async () => {
    await expect(bootstrapSuperAdmin(ctx.prisma, { username: `ops${id}`, email: `other${id}@example.test`, fullName: 'Ops Admin', additional: true })).rejects.toThrow(/already in use/);
  });
});
