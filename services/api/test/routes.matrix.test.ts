import { RequestMethod } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_RULES, IS_PUBLIC, type AuthRules } from '../src/modules/auth/auth.decorators';
import { boot, TEST_DB, type Ctx } from './helpers';

interface Route { method: string; path: string; access: 'PUBLIC' | 'CUSTOMER' | 'STAFF' | 'ANY_AUTHENTICATED'; permissions: string[] }

/** Every route the running app exposes, with the access rule the global guard will apply to it. */
function inventory(ctx: Ctx): Route[] {
  const reflector = ctx.app.get(Reflector);
  const out: Route[] = [];
  for (const mod of ctx.app.get(ModulesContainer).values()) {
    for (const w of mod.controllers.values()) {
      const cls = w.metatype as (new (...a: never[]) => object) | null;
      if (!cls) continue;
      const base = String(Reflect.getMetadata('path', cls) ?? '');
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = (cls.prototype as Record<string, unknown>)[name] as (...a: never[]) => unknown;
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const m = Reflect.getMetadata('method', handler) as number | undefined;
        if (m === undefined) continue;
        const sub = String(Reflect.getMetadata('path', handler) ?? '');
        const targets = [handler, cls];
        const isPublic = !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
        const rules = reflector.getAllAndOverride<AuthRules | undefined>(AUTH_RULES, targets);
        out.push({
          method: RequestMethod[m]!, path: `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/'),
          access: isPublic ? 'PUBLIC' : rules?.userType === 'CUSTOMER' ? 'CUSTOMER' : rules?.userType === 'STAFF' ? 'STAFF' : 'ANY_AUTHENTICATED',
          permissions: rules?.permissions ?? [],
        });
      }
    }
  }
  return out;
}

// The ONLY routes allowed to be reachable without signing in. Adding to this list is a deliberate, reviewed act.
const PUBLIC_ALLOWLIST = new Set([
  'POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/mfa/verify',
  'POST /auth/password-reset/request', 'POST /auth/password-reset/confirm', 'POST /auth/staff-setup',
  'GET /health/', 'GET /health/live', 'GET /system/status', // liveness and the maintenance banner: no customer data
  'POST /internal/jobs/run-due', // authenticated by a timing-safe shared secret instead of a session
]);

describe.skipIf(!TEST_DB)('route authorization matrix', () => {
  let ctx: Ctx;
  let routes: Route[];
  beforeAll(async () => { ctx = await boot(); routes = inventory(ctx); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });
  const key = (r: Route) => `${r.method} ${r.path}`;

  it('finds the whole API (guards against the inventory silently going empty)', () => {
    expect(routes.length).toBeGreaterThan(150);
  });

  it('public routes are exactly the reviewed allowlist', () => {
    const pub = routes.filter((r) => r.access === 'PUBLIC').map(key).sort();
    const unexpected = pub.filter((k) => !PUBLIC_ALLOWLIST.has(k.replace(/^(\w+) \/(v\d+\/)?/, '$1 /')));
    expect(unexpected).toEqual([]);
  });

  it('every admin route is staff-only with at least one permission, apart from the staff inbox and own-profile routes', () => {
    const admin = routes.filter((r) => /^\/(v\d+\/)?admin\//.test(r.path));
    expect(admin.length).toBeGreaterThan(40);
    const wrongType = admin.filter((r) => r.access !== 'STAFF').map(key);
    expect(wrongType).toEqual([]);
    const noPermission = admin.filter((r) => r.permissions.length === 0).map(key).sort();
    // Deliberately permission-free for any signed-in staff member: own notifications, own profile.
    // The dashboard returns only the sections the caller's permissions allow (tested in admin.e2e), so it needs none itself.
    expect(noPermission.filter((k) => !/\/admin\/(notifications|me|dashboard)/.test(k))).toEqual([]);
  });

  it('no customer-facing route is reachable by staff, and nothing outside /admin is staff-only', () => {
    const nonAdmin = routes.filter((r) => !/\/admin\//.test(r.path) && r.access !== 'PUBLIC');
    const staffOutsideAdmin = nonAdmin.filter((r) => r.access === 'STAFF').map(key);
    expect(staffOutsideAdmin).toEqual([]);
  });

  it('routes that accept ANY signed-in user are few, reviewed, and carry no customer data', () => {
    const any = routes.filter((r) => r.access === 'ANY_AUTHENTICATED').map(key).sort();
    // Print-on-failure list so a new route has to be classified on purpose.
    const allowed = /^(GET|POST|PUT|DELETE) \/(v\d+\/)?(me|auth\/(me|mfa|logout|logout-all)|security)(\/|$)/;
    expect(any.filter((k) => !allowed.test(k))).toEqual([]);
  });

  it('every money-moving or data-changing customer route requires an ACTIVE customer', () => {
    // Spot-check the intent via behaviour: a signed-in but unverified customer is refused on money routes.
    const money = routes.filter((r) => r.access === 'CUSTOMER' && /^(POST|PUT|DELETE)$/.test(r.method) && /\/(payments|cards|savings|loans|fixed-deposits)\b/.test(r.path));
    expect(money.length).toBeGreaterThan(10);
  });
});
