import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ENV, type Env } from '../../config/env';
import { encrypt, randomToken, sha256 } from '../../security/crypto';
import { hashSecret, passwordProblem } from '../../security/password';
import { PERMISSIONS } from '../../security/rbac';
import { newTotpSecret, totpUri } from '../../security/totp';
import type { AuthUser } from '../auth/auth.decorators';

const SETUP_TTL_MS = 72 * 3_600_000;

const subset = (a: Iterable<string>, of: ReadonlySet<string>): boolean => [...a].every((x) => of.has(x));

/**
 * Staff and role administration. Three rules prevent privilege escalation, all enforced here on the server:
 *  1. You can only grant roles/permissions you hold yourself (your permission set must cover them).
 *  2. You can never change your own roles, and cannot manage anyone whose permissions exceed yours.
 *  3. The last active Super Administrator can never be removed or deactivated.
 */
@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(ENV) private readonly env: Env) {}

  private async rolePerms(keys: string[]): Promise<Map<string, Set<string>>> {
    const roles = await this.prisma.role.findMany({ where: { key: { in: keys } }, include: { permissions: { include: { permission: true } } } });
    return new Map(roles.map((r) => [r.key, new Set(r.permissions.map((p) => p.permission.key))]));
  }

  private async userPerms(userId: string): Promise<{ perms: Set<string>; roleKeys: string[] }> {
    const rows = await this.prisma.userRole.findMany({ where: { userId }, include: { role: { include: { permissions: { include: { permission: true } } } } } });
    return { roleKeys: rows.map((r) => r.role.key), perms: new Set(rows.flatMap((r) => r.role.permissions.map((p) => p.permission.key))) };
  }

  private async staffTarget(id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, type: 'STAFF' }, include: { staff: true } });
    if (!u || !u.staff) throw new NotFoundException({ code: 'not_found', message: 'Staff member not found' });
    return u;
  }

  private async assertCanManage(actor: AuthUser, targetId: string) {
    if (actor.id === targetId) throw new ForbiddenException({ code: 'self_modification', message: 'You cannot change your own access' });
    const t = await this.userPerms(targetId);
    if (!subset(t.perms, actor.permissions)) throw new ForbiddenException({ code: 'target_more_privileged', message: 'You cannot manage someone with more access than you have' });
    return t;
  }

  private async activeSuperAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { type: 'STAFF', status: 'ACTIVE', staff: { active: true }, roles: { some: { role: { key: 'SUPER_ADMIN' } } } } });
  }

  async list() {
    const users = await this.prisma.user.findMany({ where: { type: 'STAFF' }, orderBy: { createdAt: 'asc' }, include: { staff: true, roles: { include: { role: true } } } });
    const last = await this.prisma.loginHistory.groupBy({ by: ['userId'], where: { userId: { in: users.map((u) => u.id) }, success: true }, _max: { createdAt: true } });
    const lastBy = new Map(last.map((l) => [l.userId, l._max.createdAt]));
    return { items: users.map((u) => ({ userId: u.id, fullName: u.staff?.fullName, username: u.username, email: u.email, employeeNo: u.staff?.employeeNo, active: !!u.staff?.active && u.status === 'ACTIVE', mfaEnrolled: !!u.mfaSecretEnc, roles: u.roles.map((r) => r.role.key), lastLoginAt: lastBy.get(u.id) ?? null })) };
  }

  async provision(actor: AuthUser, i: { fullName: string; username: string; email: string; roleKeys: string[] }) {
    const wanted = await this.rolePerms(i.roleKeys);
    for (const k of i.roleKeys) if (!wanted.has(k)) throw new BadRequestException({ code: 'unknown_role', message: `Unknown role ${k}`, fields: { roleKeys: 'Unknown role' } });
    for (const [k, p] of wanted) if (!subset(p, actor.permissions)) throw new ForbiddenException({ code: 'privilege_escalation', message: `You cannot grant the ${k} role: it includes access you do not have` });
    const username = i.username.toLowerCase();
    const email = i.email.toLowerCase();
    if (await this.prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } })) throw new ConflictException({ code: 'already_registered', message: 'That username or email is already in use' });

    const token = randomToken();
    // The password is a random value nobody knows: the invitee cannot sign in until they complete setup.
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { type: 'STAFF', username, email, status: 'ACTIVE', passwordHash: await hashSecret(randomToken(48)), staff: { create: { employeeNo: `EMP-${String(randomInt(0, 1e8)).padStart(8, '0')}`, fullName: i.fullName.trim() } } },
      });
      for (const k of wanted.keys()) await tx.userRole.create({ data: { userId: u.id, roleId: (await tx.role.findUniqueOrThrow({ where: { key: k } })).id } });
      await tx.authenticationChallenge.create({ data: { userId: u.id, purpose: 'STAFF_SETUP', tokenHash: sha256(token), expiresAt: new Date(Date.now() + SETUP_TTL_MS) } });
      await this.audit.record({ actorId: actor.id, actorType: 'STAFF', action: 'staff.provisioned', subjectType: 'User', subjectId: u.id, metadata: { roles: i.roleKeys } }, tx);
      // Delivery of the invitation (email) is added with notifications; the raw token is only echoed in development.
      await tx.outboxEvent.create({ data: { topic: 'staff.invited', payload: { userId: u.id } } });
      return u;
    });
    return { userId: created.id, username, ...(this.env.APP_ENV === 'development' || (this.env.APP_ENV === 'staging' && this.env.ALLOW_SETUP_TOKEN_IN_RESPONSE) ? { setupToken: token } : {}) };
  }

  /** Public, single-use. The invitee chooses a password and receives their authenticator secret exactly once. */
  async completeSetup(token: string, password: string) {
    const bad = new UnauthorizedException({ code: 'invalid_setup_token', message: 'This invitation is invalid or has expired' });
    const ch = await this.prisma.authenticationChallenge.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { include: { staff: true } } } });
    if (!ch || ch.purpose !== 'STAFF_SETUP' || ch.consumedAt || ch.expiresAt < new Date() || ch.user.type !== 'STAFF') throw bad;
    const problem = passwordProblem(password, [ch.user.username, ...(ch.user.staff?.fullName.split(/\s+/) ?? [])]);
    if (problem) throw new BadRequestException({ code: 'weak_password', message: problem, fields: { password: problem } });
    const secret = newTotpSecret();
    const key = Buffer.from(this.env.DATA_ENCRYPTION_KEY, 'base64');
    const passwordHash = await hashSecret(password);
    await this.prisma.$transaction(async (tx) => {
      const used = await tx.authenticationChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (used.count !== 1) throw bad;
      await tx.user.update({ where: { id: ch.userId }, data: { passwordHash, mfaSecretEnc: encrypt(secret, key), failedLogins: 0, lockedUntil: null } });
      await this.audit.record({ actorId: ch.userId, actorType: 'STAFF', action: 'staff.setup_completed', subjectType: 'User', subjectId: ch.userId }, tx);
    });
    return { secret, otpauthUri: totpUri(secret, ch.user.username) };
  }

  async setRoles(actor: AuthUser, targetId: string, roleKeys: string[]) {
    const target = await this.staffTarget(targetId);
    const current = await this.assertCanManage(actor, targetId);
    const wanted = await this.rolePerms(roleKeys);
    for (const k of roleKeys) if (!wanted.has(k)) throw new BadRequestException({ code: 'unknown_role', message: `Unknown role ${k}` });
    for (const [k, p] of wanted) if (!subset(p, actor.permissions)) throw new ForbiddenException({ code: 'privilege_escalation', message: `You cannot grant the ${k} role: it includes access you do not have` });
    if (current.roleKeys.includes('SUPER_ADMIN') && !roleKeys.includes('SUPER_ADMIN') && (await this.activeSuperAdmins()) <= 1)
      throw new ConflictException({ code: 'last_super_admin', message: 'The last Super Administrator cannot be demoted' });
    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: targetId } });
      for (const k of roleKeys) await tx.userRole.create({ data: { userId: targetId, roleId: (await tx.role.findUniqueOrThrow({ where: { key: k } })).id } });
      await tx.session.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date() } }); // fresh sign-in under the new access
      await this.audit.record({ actorId: actor.id, actorType: 'STAFF', action: 'staff.roles_changed', subjectType: 'User', subjectId: targetId, metadata: { from: current.roleKeys, to: roleKeys } }, tx);
    });
    return { userId: target.id, roles: roleKeys };
  }

  async setActive(actor: AuthUser, targetId: string, active: boolean, reason: string) {
    await this.staffTarget(targetId);
    const t = await this.assertCanManage(actor, targetId);
    if (!active && t.roleKeys.includes('SUPER_ADMIN') && (await this.activeSuperAdmins()) <= 1) throw new ConflictException({ code: 'last_super_admin', message: 'The last Super Administrator cannot be deactivated' });
    await this.prisma.$transaction(async (tx) => {
      await tx.staffProfile.update({ where: { userId: targetId }, data: { active } });
      await tx.user.update({ where: { id: targetId }, data: { status: active ? 'ACTIVE' : 'SUSPENDED' } });
      if (!active) await tx.session.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: actor.id, actorType: 'STAFF', action: active ? 'staff.activated' : 'staff.deactivated', subjectType: 'User', subjectId: targetId, reasonCode: reason.slice(0, 100) }, tx);
    });
    return { userId: targetId, active };
  }

  async revokeSessions(actor: AuthUser, targetId: string) {
    await this.staffTarget(targetId);
    if (targetId !== actor.id) await this.assertCanManage(actor, targetId);
    const r = await this.prisma.session.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorId: actor.id, actorType: 'STAFF', action: 'staff.sessions_revoked', subjectType: 'User', subjectId: targetId, metadata: { count: r.count } });
    return { revoked: r.count };
  }

  async loginHistory(targetId: string) {
    await this.staffTarget(targetId);
    const rows = await this.prisma.loginHistory.findMany({ where: { userId: targetId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: rows.map((r) => ({ at: r.createdAt, success: r.success, ip: r.ip, userAgent: r.userAgent })) };
  }

  // ───────────────────────── roles ─────────────────────────
  async roles() {
    const roles = await this.prisma.role.findMany({ orderBy: { key: 'asc' }, include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } } });
    return {
      permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
      items: roles.map((r) => ({ key: r.key, name: r.name, system: r.system, members: r._count.users, permissions: r.permissions.map((p) => p.permission.key).sort() })),
    };
  }

  async setRolePermissions(actor: AuthUser, roleKey: string, keys: string[]) {
    if (roleKey === 'SUPER_ADMIN') throw new ConflictException({ code: 'immutable_role', message: 'The Super Administrator role cannot be edited' });
    const role = await this.prisma.role.findUnique({ where: { key: roleKey }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw new NotFoundException({ code: 'not_found', message: 'Role not found' });
    const unknown = keys.filter((k) => !(k in PERMISSIONS));
    if (unknown.length) throw new BadRequestException({ code: 'unknown_permission', message: `Unknown permission: ${unknown[0]}` });
    const before = new Set(role.permissions.map((p) => p.permission.key));
    const added = keys.filter((k) => !before.has(k));
    const lacking = added.filter((k) => !actor.permissions.has(k));
    if (lacking.length) throw new ForbiddenException({ code: 'privilege_escalation', message: `You cannot grant ${lacking[0]}: you do not hold it yourself` });
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      const perms = await tx.permission.findMany({ where: { key: { in: keys } } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      await this.audit.record({ actorId: actor.id, actorType: 'STAFF', action: 'role.permissions_changed', subjectType: 'Role', subjectId: roleKey, metadata: { added, removed: [...before].filter((k) => !keys.includes(k)) } as Prisma.InputJsonValue }, tx);
    });
    return { key: roleKey, permissions: [...keys].sort() };
  }
}
