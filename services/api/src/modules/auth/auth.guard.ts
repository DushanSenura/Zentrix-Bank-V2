import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { AUTH_RULES, type AuthRules, type AuthUser, IS_PUBLIC } from './auth.decorators';
import { TokenService } from './token.service';

/** Global guard: every route requires a valid, non-revoked session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await this.tokens.verify(token) : null;
    if (!claims) throw new UnauthorizedException({ code: 'unauthenticated', message: 'Please sign in again' });

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      include: { user: { include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== claims.sub)
      throw new UnauthorizedException({ code: 'session_expired', message: 'Your session has ended. Please sign in again' });
    const u = session.user;
    if (u.status === 'SUSPENDED' || u.status === 'CLOSED')
      throw new UnauthorizedException({ code: 'account_unavailable', message: 'This account is not available' });

    const user: AuthUser = {
      id: u.id,
      type: u.type,
      status: u.status,
      sessionId: session.id,
      permissions: new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key))),
    };
    req.user = user;

    const rules = this.reflector.getAllAndOverride<AuthRules | undefined>(AUTH_RULES, targets);
    if (rules) {
      const missing = rules.permissions?.filter((p) => !user.permissions.has(p)) ?? [];
      const wrongType = rules.userType && rules.userType !== user.type;
      const inactive = rules.requireActive && user.status !== 'ACTIVE';
      if (wrongType || missing.length || inactive) {
        await this.audit.securityEvent('FORBIDDEN_ENDPOINT_ACCESS', user.id, {
          path: String(req.route?.path ?? ''),
          method: req.method,
          reason: wrongType ? 'wrong_user_type' : inactive ? 'inactive_user' : 'missing_permission',
        });
        throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this resource' });
      }
    }
    return true;
  }
}
