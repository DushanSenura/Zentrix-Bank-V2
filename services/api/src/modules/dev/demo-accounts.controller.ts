import { Controller, Get, Inject, NotFoundException, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../common/prisma.service';
import { ENV, type Env } from '../../config/env';
import { totpNow } from '../../security/totp';
import { Public } from '../auth/auth.decorators';

/** Loopback or private-network callers only (the emulator reaches the host as 10.0.2.2). */
export function isLocalNetwork(addr: string | undefined): boolean {
  const a = (addr ?? '').replace(/^::ffff:/, '');
  return a === '::1' || a === '127.0.0.1' || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

interface Entry { password?: string; pin?: string; totpSecretBase32?: string }

/**
 * DEVELOPMENT ONLY. Lists the fictional demo accounts from the local, git-ignored credentials file so the sign-in screens can show them.
 * It answers 404 unless APP_ENV is exactly "development", and only to callers on a local or private network, so staging and
 * production never expose it even if the route is reachable. Authenticator secrets are never returned: for staff it returns the
 * CURRENT six-digit code instead. Real customers' data and real passwords are never involved: the file only holds seeded demo users.
 */
@ApiExcludeController()
@Controller({ path: 'dev', version: '1' })
export class DemoAccountsController {
  constructor(private readonly prisma: PrismaService, @Inject(ENV) private readonly env: Env) {}

  @Public() @Get('demo-accounts')
  async list(@Req() req: Request, file = process.env.DEMO_CREDENTIALS_FILE ?? resolve(process.cwd(), '../../.local-dev-credentials.json')) {
    if (this.env.APP_ENV !== 'development' || !isLocalNetwork(req.socket?.remoteAddress)) throw new NotFoundException({ code: 'not_found', message: 'Not found' });
    if (!existsSync(file)) return { accounts: [], note: 'No demo credentials file. Run: pnpm db:seed' };
    const creds = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry | string>;
    const names = Object.keys(creds).filter((k) => typeof creds[k] === 'object' && (creds[k] as Entry).password);
    const users = await this.prisma.user.findMany({ where: { username: { in: names } }, include: { roles: { include: { role: true } }, customer: true, staff: true } });
    const now = Date.now();
    const accounts = users.map((u) => {
      const c = creds[u.username] as Entry;
      return {
        username: u.username, password: c.password, kind: u.type, fullName: u.staff?.fullName ?? u.customer?.fullName ?? u.username,
        role: u.type === 'STAFF' ? (u.roles[0]?.role.name ?? 'Staff') : 'Customer',
        ...(c.pin ? { pin: c.pin } : {}),
        ...(u.type === 'STAFF' && c.totpSecretBase32 ? { mfaCode: totpNow(c.totpSecretBase32), mfaSecondsLeft: 30 - (Math.floor(now / 1000) % 30) } : {}),
      };
    }).sort((a, b) => (a.kind === b.kind ? a.role.localeCompare(b.role) : a.kind === 'STAFF' ? -1 : 1));
    return { accounts, note: 'Development only. Fictional people and money.' };
  }
}
