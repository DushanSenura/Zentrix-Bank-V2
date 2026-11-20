import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DemoAccountsController, isLocalNetwork } from '../src/modules/dev/demo-accounts.controller';
import { newTotpSecret, totpNow } from '../src/security/totp';

const req = (addr: string) => ({ socket: { remoteAddress: addr } }) as never;
const prisma = (users: unknown[]) => ({ user: { findMany: async () => users } }) as never;
const secret = newTotpSecret();
const file = join(mkdtempSync(join(tmpdir(), 'demo-')), 'creds.json');
writeFileSync(file, JSON.stringify({ note: 'x', 'admin.demo': { password: 'pw-A', totpSecretBase32: secret }, 'amaya.demo': { password: 'pw-B', pin: '482916' }, 'ghost.demo': { password: 'pw-C' } }));
const users = [
  { username: 'amaya.demo', type: 'CUSTOMER', roles: [], customer: { fullName: 'Amaya' }, staff: null },
  { username: 'admin.demo', type: 'STAFF', roles: [{ role: { name: 'Super Administrator' } }], customer: null, staff: { fullName: 'Demo Admin' } },
];
const ctl = (env: string) => new DemoAccountsController(prisma(users), { APP_ENV: env } as never);

describe('development demo accounts endpoint', () => {
  it('is invisible (404) in every environment except development', async () => {
    for (const env of ['staging', 'production', 'test']) await expect(ctl(env).list(req('127.0.0.1'), file)).rejects.toMatchObject({ status: 404 });
  });

  it('is invisible to callers outside the local or private network, even in development', async () => {
    for (const addr of ['8.8.8.8', '203.0.113.9', '::ffff:93.184.216.34', '172.32.0.1', '']) await expect(ctl('development').list(req(addr), file)).rejects.toMatchObject({ status: 404 });
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.2.2', '192.168.1.20', '172.16.5.5']) expect(isLocalNetwork(addr), addr).toBe(true);
  });

  it('lists seeded users with their roles and, for staff, the CURRENT code rather than the authenticator secret', async () => {
    const r = await ctl('development').list(req('10.0.2.2'), file);
    expect(r.accounts.map((a) => a.username)).toEqual(['admin.demo', 'amaya.demo']); // staff first; users absent from the DB are not listed
    const admin = r.accounts[0]!;
    expect(admin).toMatchObject({ role: 'Super Administrator', password: 'pw-A', mfaCode: totpNow(secret) });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.accounts[1]).toMatchObject({ role: 'Customer', pin: '482916' });
    expect(r.accounts[1]).not.toHaveProperty('mfaCode');
  });

  it('degrades to an empty list with a hint when the file is missing', async () => {
    const r = await ctl('development').list(req('127.0.0.1'), join(tmpdir(), 'does-not-exist.json'));
    expect(r.accounts).toEqual([]);
  });
});
