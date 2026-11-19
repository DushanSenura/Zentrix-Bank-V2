import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, boot, makePayer, TEST_DB, u, type Ctx } from './helpers';

const LEAKS = /\bat\s+\S+\s+\(|node_modules|Prisma|PrismaClient|stack|\.ts:\d+|SELECT |INSERT |postgres|ECONN|C:\\|\/home\//i;

describe.skipIf(!TEST_DB)('HTTP hardening', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  it('sends security headers and does not advertise the framework', async () => {
    const r = await ctx.http.get('/api/v1/health/live');
    expect(r.status).toBe(200);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['content-security-policy']).toBeDefined();
  });

  it('refuses anonymous callers with one uniform body that reveals nothing', async () => {
    for (const path of ['/api/v1/accounts', '/api/v1/admin/customers', '/api/v1/payments', '/api/v1/analytics/summary']) {
      const r = await ctx.http.get(path);
      expect(r.status, path).toBe(401);
      expect(Object.keys(r.body).sort(), path).toEqual(['code', 'message', 'requestId']);
      expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    }
    const bad = await ctx.http.get('/api/v1/accounts').set({ Authorization: 'Bearer not.a.token' });
    expect(bad.status).toBe(401);
    const none = await ctx.http.get('/api/v1/nope');
    expect(none.status).toBe(404);
    expect(JSON.stringify(none.body)).not.toMatch(LEAKS);
  });

  it('malformed, oversized and hostile input gets a clean 4xx, never a 500 or a stack trace', async () => {
    const c = await makePayer(ctx, `hard${Date.now().toString(36)}`, 100_000n);
    const post = (path: string) => ctx.http.post(path).set(bearer(c.token));

    const badJson = await post('/api/v1/support/tickets').set('Content-Type', 'application/json').send('{"subject": ');
    expect(badJson.status).toBe(400);
    expect(JSON.stringify(badJson.body)).not.toMatch(LEAKS);

    const huge = await post('/api/v1/support/tickets').send({ subject: 'x'.repeat(400_000), category: 'GENERAL', message: 'hello' });
    expect(huge.status).toBe(413);

    const wrongType = await post('/api/v1/support/tickets').set('Content-Type', 'text/plain').send('subject=a');
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
    expect(wrongType.status).toBeLessThan(500);

    const nested = await post('/api/v1/payment-templates').send({ name: 'x1', destination: { type: 'ZENTRIX', accountNumber: { $ne: null } } });
    expect(nested.status).toBe(400); // object where a string belongs: no operator injection

    const proto = await post('/api/v1/support/tickets').set('Content-Type', 'application/json').send('{"__proto__":{"admin":true},"subject":"abc","category":"GENERAL","message":"hello there"}');
    expect(proto.status).toBeLessThan(500); // either rejected by the strict schema or ignored, never a crash
    expect(({} as Record<string, unknown>).admin).toBeUndefined(); // and the prototype was not polluted

    const get = (path: string) => ctx.http.get(path).set(bearer(c.token));
    for (const q of ["'; DROP TABLE \"User\"; --", '" OR 1=1 --', '%00', '\\\\', '<script>alert(1)</script>', 'a'.repeat(1000)]) {
      const r = await get(`/api/v1/transactions?q=${encodeURIComponent(q)}`);
      expect(r.status, q.slice(0, 20)).toBeLessThan(500);
      expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    }
    expect(await ctx.prisma.user.count()).toBeGreaterThan(0); // the table is still there
    for (const id of ['../../etc/passwd', '1', 'null', '%2e%2e%2f', "00000000-0000-4000-8000-000000000000'--"]) {
      const r = await get(`/api/v1/support/tickets/${encodeURIComponent(id)}`);
      expect(r.status, id).toBeGreaterThanOrEqual(400);
      expect(r.status, id).toBeLessThan(500);
    }
    const weird = await get('/api/v1/transactions?limit=-5&minMinor=abc&cursor=%ff%fe');
    expect(weird.status).toBe(400);
  });

  it('user-supplied text is stored and returned as data (no markup interpretation server-side)', async () => {
    const c = await makePayer(ctx, `xss${Date.now().toString(36)}`, 0n);
    const body = '<img src=x onerror=alert(1)> & "quotes"';
    const t = await ctx.http.post('/api/v1/support/tickets').set(bearer(c.token)).send({ subject: 'Markup test', category: 'GENERAL', message: body });
    expect(t.status).toBe(201);
    const r = await ctx.http.get(`/api/v1/support/tickets/${t.body.id}`).set(bearer(c.token));
    expect(r.headers['content-type']).toMatch(/^application\/json/); // never served as HTML
    expect(r.body.messages[0].body).toBe(body);
  });

  it('login gives identical answers for unknown users and wrong passwords', async () => {
    const attempt = (u: string) => ctx.http.post('/api/v1/auth/login').send({ identifier: u, password: 'Wrong-Passw0rd!x' });
    const unknown = await attempt(`nobody_${Date.now().toString(36)}`);
    const name = `lock${Date.now().toString(36)}`;
    await makePayer(ctx, name, 0n);
    const known = await attempt(u(name));
    expect(known.status).toBe(unknown.status);
    expect(known.body.code).toBe(unknown.body.code);
    expect(known.body.message).toBe(unknown.body.message);
  });
});
