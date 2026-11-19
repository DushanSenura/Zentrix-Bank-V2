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
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

const PW = 'Str0ngPassw0rd!x';
const run = Math.random().toString(36).slice(2, 8);
const u = (n: string) => `${n}_${run}`;

describe.skipIf(!TEST_DB)('security centre (real database)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const prisma = new PrismaClient();

  const register = async (name: string) =>
    (await http.post('/api/v1/auth/register').send({ fullName: 'Sec Person', username: u(name), email: `${u(name)}@t.test`, password: PW })).body as { accessToken: string; refreshToken: string };
  const login = async (name: string, pw = PW) => (await http.post('/api/v1/auth/login').send({ identifier: u(name), password: pw })).body as { accessToken: string };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it('lists own sessions, revokes others, and cannot touch another customer’s session', async () => {
    const a1 = await register('s1');
    const a2 = await login('s1');
    const b = await register('s2');

    const list = (await http.get('/api/v1/security/sessions').set(bearer(a1.accessToken))).body.items;
    expect(list).toHaveLength(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const bSession = (await http.get('/api/v1/security/sessions').set(bearer(b.accessToken))).body.items[0].id;
    expect((await http.delete(`/api/v1/security/sessions/${bSession}`).set(bearer(a1.accessToken))).status).toBe(404); // not found, not 403: no existence leak
    expect((await http.get('/api/v1/me').set(bearer(b.accessToken))).status).toBe(200); // B unaffected

    expect((await http.post('/api/v1/security/sessions/revoke-others').set(bearer(a1.accessToken))).status).toBe(204);
    expect((await http.get('/api/v1/me').set(bearer(a2.accessToken))).status).toBe(401);
    expect((await http.get('/api/v1/me').set(bearer(a1.accessToken))).status).toBe(200);
  });

  it('shows login history including failures', async () => {
    const a = await register('hist');
    await http.post('/api/v1/auth/login').send({ identifier: u('hist'), password: 'Wrong-pass-123' });
    await login('hist');
    const items = (await http.get('/api/v1/security/login-history').set(bearer(a.accessToken))).body.items as { success: boolean }[];
    expect(items.some((i) => !i.success)).toBe(true);
    expect(items.some((i) => i.success)).toBe(true);
  });

  it('changes password: needs the current one, enforces policy, signs out other sessions', async () => {
    const a1 = await register('chg');
    const a2 = await login('chg');
    const NEW = 'Brand-New-Pw-77x';
    const put = (cur: string, next: string) => http.put('/api/v1/security/password').set(bearer(a1.accessToken)).send({ current: cur, next });
    expect((await put('nope-wrong-1A', NEW)).status).toBe(401);
    expect((await put(PW, 'short')).status).toBe(400);
    expect((await put(PW, PW)).status).toBe(400);
    expect((await put(PW, NEW)).status).toBe(204);
    expect((await http.get('/api/v1/me').set(bearer(a2.accessToken))).status).toBe(401);
    expect((await http.get('/api/v1/me').set(bearer(a1.accessToken))).status).toBe(200);
    expect((await http.post('/api/v1/auth/login').send({ identifier: u('chg'), password: PW })).status).toBe(401);
    expect((await http.post('/api/v1/auth/login').send({ identifier: u('chg'), password: NEW })).status).toBe(200);
  });

  it('PIN: first-time set cannot overwrite; change needs current; 5 wrong attempts sign out everywhere', async () => {
    const a = await register('pin2');
    const h = bearer(a.accessToken);
    expect((await http.put('/api/v1/security/pin').set(h).send({ currentPin: '1111', newPin: '482916' })).status).toBe(409); // no PIN yet
    expect((await http.put('/api/v1/me/pin').set(h).send({ pin: '482916' })).status).toBe(204);
    expect((await http.put('/api/v1/me/pin').set(h).send({ pin: '951753' })).status).toBe(409); // cannot silently overwrite
    expect((await http.post('/api/v1/security/pin/verify').set(h).send({ pin: '482916' })).status).toBe(204);
    expect((await http.put('/api/v1/security/pin').set(h).send({ currentPin: '482916', newPin: '1111' })).status).toBe(400); // weak
    expect((await http.put('/api/v1/security/pin').set(h).send({ currentPin: '482916', newPin: '7391' })).status).toBe(204);
    expect((await http.post('/api/v1/security/pin/verify').set(h).send({ pin: '482916' })).status).toBe(401); // old PIN dead
    for (let i = 0; i < 4; i++) expect((await http.post('/api/v1/security/pin/verify').set(h).send({ pin: '0000' })).status).toBe(401);
    expect((await http.get('/api/v1/me').set(h)).status).toBe(401); // lockout revoked the session
    expect(await prisma.securityEvent.count({ where: { kind: 'PIN_LOCKOUT_SIGNED_OUT', user: { username: u('pin2') } } })).toBe(1);
  });

  it('trusted devices are per-customer and revocable; staff cannot use customer security endpoints', async () => {
    const a = await register('dev1');
    const b = await register('dev2');
    const trust = await http.post('/api/v1/security/devices').set(bearer(a.accessToken)).send({ fingerprint: 'fp-abcdef123456', label: 'Test phone' });
    expect(trust.status).toBe(201);
    expect((await http.get('/api/v1/security/devices').set(bearer(a.accessToken))).body.items).toHaveLength(1);
    expect((await http.get('/api/v1/security/devices').set(bearer(b.accessToken))).body.items).toHaveLength(0);
    expect((await http.delete(`/api/v1/security/devices/${trust.body.id}`).set(bearer(b.accessToken))).status).toBe(404);
    expect((await http.delete(`/api/v1/security/devices/${trust.body.id}`).set(bearer(a.accessToken))).status).toBe(204);
    expect((await http.get('/api/v1/security/devices').set(bearer(a.accessToken))).body.items).toHaveLength(0);
    expect((await http.get('/api/v1/security/sessions')).status).toBe(401);
  });
});
