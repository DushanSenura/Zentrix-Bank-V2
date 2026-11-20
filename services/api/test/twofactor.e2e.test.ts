import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { totpNow } from '../src/security/totp';
import { bearer, boot, makePayer, PIN, PW, TEST_DB, u, type Ctx, type Payer } from './helpers';

describe.skipIf(!TEST_DB)('customer two-step sign-in (real database)', () => {
  let ctx: Ctx;
  const id = randomBytes(3).toString('hex');
  let n = 0;
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const S = (p: Payer, method: 'get' | 'post', path: string, body?: object) => ctx.http[method](`/api/v1/security/2fa${path}`).set(bearer(p.token)).send(body);
  const login = (name: string, extra: object = {}) => ctx.http.post('/api/v1/auth/login').send({ identifier: u(name), password: PW, ...extra });

  async function enroll(name: string) {
    const p = await makePayer(ctx, name, 0n);
    const setup = await S(p, 'post', '/setup', { pin: PIN });
    expect(setup.status).toBe(200);
    const en = await S(p, 'post', '/enable', { code: totpNow(setup.body.secret) });
    expect(en.status).toBe(200);
    return { p, secret: setup.body.secret as string, codes: en.body.recoveryCodes as string[] };
  }

  it('enrolment needs the PIN and a working code, and changes nothing until confirmed', async () => {
    const name = `tf${n++}${id}`;
    const p = await makePayer(ctx, name, 0n);
    expect((await S(p, 'get', '')).body).toMatchObject({ enabled: false, recoveryCodesLeft: 0 });
    expect((await S(p, 'post', '/setup', { pin: '000000' })).status).toBe(401);
    expect((await S(p, 'post', '/enable', { code: '123456' })).status).toBe(409); // not started
    const setup = await S(p, 'post', '/setup', { pin: PIN });
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await login(name)).status).toBe(200); // pending enrolment does not affect sign-in yet
    expect((await S(p, 'post', '/enable', { code: '000000' })).status).toBe(401);
    const ok = await S(p, 'post', '/enable', { code: totpNow(setup.body.secret) });
    expect(ok.body.recoveryCodes).toHaveLength(8);
    expect(new Set(ok.body.recoveryCodes).size).toBe(8);
    expect(ok.body.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect((await S(p, 'get', '')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 8 });
    expect((await S(p, 'post', '/setup', { pin: PIN })).status).toBe(409);
    // Only hashes are stored.
    const rows = await ctx.prisma.recoveryCode.findMany({ where: { userId: p.id } });
    expect(rows.every((r) => !ok.body.recoveryCodes.some((c: string) => r.codeHash.includes(c.replace('-', ''))))).toBe(true);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(p.token))).body.items.some((x: { title: string }) => x.title === 'Two-step sign-in is on')).toBe(true);
  });

  it('once on, sign-in asks for a code: wrong ones fail alike, the right one works, and other customers are unaffected', async () => {
    const name = `tg${n++}${id}`;
    const { secret } = await enroll(name);
    const bystander = await makePayer(ctx, `tb${n++}${id}`, 0n);

    const need = await login(name);
    expect(need.status).toBe(401);
    expect(need.body.code).toBe('mfa_required');
    expect(need.body.accessToken).toBeUndefined();
    const wrong = await login(name, { mfaCode: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).not.toBe('mfa_required'); // generic failure, no hint
    const ok = await login(name, { mfaCode: totpNow(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect((await login(`x`)).status).toBe(401);
    expect((await ctx.http.post('/api/v1/auth/login').send({ identifier: u(`tb${n - 1}${id}`), password: PW })).status).toBe(200);
    expect(bystander.token).toBeTruthy();
  });

  it('a recovery code signs in once, is spent, and is audited', async () => {
    const name = `th${n++}${id}`;
    const { p, codes } = await enroll(name);
    const first = await login(name, { recoveryCode: codes[0]!.toLowerCase().replace('-', ' ') }); // case, spaces and dashes do not matter
    expect(first.status).toBe(200);
    const again = await login(name, { recoveryCode: codes[0] });
    expect(again.status).toBe(401);
    expect((await login(name, { recoveryCode: 'AAAAA-AAAAA' })).status).toBe(401);
    expect((await S(p, 'get', '')).body.recoveryCodesLeft).toBe(7);
    expect(await ctx.prisma.securityEvent.count({ where: { userId: p.id, kind: 'RECOVERY_CODE_USED' } })).toBe(1);
  });

  it('turning it off needs the PIN and a code; regenerating replaces the old recovery codes', async () => {
    const name = `ti${n++}${id}`;
    const { p, secret, codes } = await enroll(name);
    expect((await S(p, 'post', '/disable', { pin: PIN, code: '000000' })).status).toBe(401);
    expect((await S(p, 'post', '/disable', { pin: '000000', code: totpNow(secret) })).status).toBe(401);

    const regen = await S(p, 'post', '/recovery-codes', { pin: PIN, code: totpNow(secret) });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(8);
    expect((await login(name, { recoveryCode: codes[1] })).status).toBe(401); // the old set is dead
    expect((await login(name, { recoveryCode: regen.body.recoveryCodes[0] })).status).toBe(200);

    // A recovery code can also authorise switching it off (a customer who lost the phone).
    const off = await S(p, 'post', '/disable', { pin: PIN, code: regen.body.recoveryCodes[1] });
    expect(off.status).toBe(204);
    expect((await S(p, 'get', '')).body).toMatchObject({ enabled: false, recoveryCodesLeft: 0 });
    expect((await login(name)).status).toBe(200); // plain sign-in again
    expect(await ctx.prisma.auditLog.count({ where: { actorId: p.id, action: { in: ['security.2fa_enabled', 'security.2fa_disabled'] } } })).toBe(2);
    expect((await S(p, 'post', '/disable', { pin: PIN, code: totpNow(secret) })).status).toBe(409); // already off
  });

  it('is customer-only and needs a signed-in caller', async () => {
    expect((await ctx.http.get('/api/v1/security/2fa')).status).toBe(401);
    expect((await ctx.http.post('/api/v1/security/2fa/setup').send({ pin: PIN })).status).toBe(401);
  });
});
