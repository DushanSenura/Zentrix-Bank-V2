import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export interface AuthUser {
  id: string;
  type: 'CUSTOMER' | 'STAFF';
  status: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
}

export const IS_PUBLIC = 'isPublic';
export const AUTH_RULES = 'authRules';

export interface AuthRules {
  userType?: 'CUSTOMER' | 'STAFF';
  permissions?: string[];
  requireActive?: boolean;
}

/** No authentication required. Everything else is authenticated by default (deny by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const CustomerOnly = (opts: { requireActive?: boolean } = {}) => SetMetadata(AUTH_RULES, { userType: 'CUSTOMER', ...opts } satisfies AuthRules);
/** Staff-only; the caller must hold ALL listed permissions. */
export const StaffWith = (...permissions: string[]) => SetMetadata(AUTH_RULES, { userType: 'STAFF', permissions } satisfies AuthRules);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser =>
  ctx.switchToHttp().getRequest().user,
);
