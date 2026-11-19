#!/usr/bin/env node
/**
 * Post-deployment smoke test. Talks to a RUNNING stack through its public address (the admin origin, which proxies /api).
 *   BASE_URL=https://staging-admin.example.test node infrastructure/scripts/smoke.mjs
 *   SMOKE_REGISTER=1 ...   also registers a throwaway customer and exercises sign-in, refresh and sign-out
 *
 * It never uses or needs staff credentials, never moves money, and prints no secrets. Exit code 0 only if every check passes.
 */
const base = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const results = [];
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };
const truthy = (v, what) => { if (!v) throw new Error(String(what).includes(' ') ? `failed: ${what}` : `${what} missing`); };
const api = (path, init = {}) => fetch(`${base}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });

await check('admin portal serves HTML with security headers', async () => {
  const r = await fetch(`${base}/`);
  eq(r.status, 200, 'status');
  truthy((r.headers.get('content-type') ?? '').includes('text/html'), 'html content type');
  eq(r.headers.get('x-content-type-options'), 'nosniff', 'x-content-type-options');
  truthy(r.headers.get('content-security-policy')?.includes("default-src 'self'"), 'content-security-policy');
  eq(r.headers.get('x-frame-options'), 'DENY', 'x-frame-options');
  truthy(!/nginx\/\d/.test(r.headers.get('server') ?? ''), 'server header must not reveal the nginx version');
});

await check('admin routes fall back to the app (deep link)', async () => {
  const r = await fetch(`${base}/customers/123`);
  eq(r.status, 200, 'status');
  truthy((await r.text()).includes('<div id="root">'), 'app shell');
});

await check('API liveness through the proxy', async () => {
  const r = await api('/health/live');
  eq(r.status, 200, 'status');
  eq(r.headers.get('x-powered-by'), null, 'x-powered-by');
  truthy(r.headers.get('strict-transport-security'), 'strict-transport-security');
});

await check('API readiness reports its dependencies', async () => {
  const r = await api('/health');
  eq(r.status, 200, 'status');
  const b = await r.json();
  eq(b.status, 'ok', 'overall status');
  eq(b.checks?.database?.status, 'up', 'database');
  eq(b.checks?.redis?.status, 'up', 'redis');
});

await check('maintenance banner endpoint is public and shaped correctly', async () => {
  const r = await api('/system/status');
  eq(r.status, 200, 'status');
  eq(typeof (await r.json()).maintenance, 'boolean', 'maintenance flag');
});

await check('protected routes refuse anonymous callers with a uniform body', async () => {
  for (const p of ['/accounts', '/payments', '/admin/customers', '/analytics/summary']) {
    const r = await api(p);
    eq(r.status, 401, `${p} status`);
    const b = await r.json();
    eq(Object.keys(b).sort().join(','), 'code,message,requestId', `${p} body shape`);
  }
});

await check('the internal job endpoint refuses callers without the shared secret', async () => {
  const r = await api('/internal/jobs/run-due', { method: 'POST' });
  truthy([401, 503].includes(r.status), `expected 401/503, got ${r.status}`);
});

await check('oversized request bodies get 413, not a server error', async () => {
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'x'.repeat(400_000), password: 'y' }) });
  eq(r.status, 413, 'status');
});

if (process.env.SMOKE_REGISTER === '1') {
  const id = Math.random().toString(36).slice(2, 10);
  const user = { fullName: 'Smoke Test', username: `smoke_${id}`, email: `smoke_${id}@example.test`, password: `Violet-Harbor-${id}-Lamp-7!q` }  // must not contain the name or username;
  let tokens;
  await check('a new customer can register and sign in', async () => {
    const reg = await api('/auth/register', { method: 'POST', body: JSON.stringify(user) });
    truthy([200, 201].includes(reg.status), `register status ${reg.status}`);
    const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: user.username, password: user.password }) });
    eq(login.status, 200, 'login status');
    tokens = await login.json();
    truthy(tokens.accessToken && tokens.refreshToken, 'tokens');
  });
  if (tokens) {
    const auth = () => ({ authorization: `Bearer ${tokens.accessToken}` });
    await check('an unverified customer is held back from money routes', async () => {
      const me = await api('/me', { headers: auth() });
      eq(me.status, 200, '/me status');
      const pay = await api('/payments', { method: 'POST', headers: { ...auth(), 'idempotency-key': 'smoke-key-0123456789' }, body: JSON.stringify({}) });
      truthy([400, 403].includes(pay.status), `payments status ${pay.status}`);
    });
    await check('a customer cannot reach staff routes', async () => {
      eq((await api('/admin/customers', { headers: auth() })).status, 403, 'status');
    });
    await check('refresh rotates the token and the old one stops working', async () => {
      const r = await api('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: tokens.refreshToken }) });
      eq(r.status, 200, 'status');
      const again = await api('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: tokens.refreshToken }) });
      eq(again.status, 401, 'reuse of the old refresh token');
    });
  }
}

console.log(`Smoke test against ${base}\n${results.join('\n')}\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
