import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Patch, Put, UnprocessableEntityException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { num } from '../accounts/accounts.service';
import { CurrentUser, CustomerOnly, type AuthUser } from '../auth/auth.decorators';
import { PinService } from '../auth/pin.service';
import { PolicyService, startOfBankingDay } from '../payments/policy.service';

/** Notification categories a customer may switch off. SECURITY is deliberately absent: it is always delivered. */
export const MUTABLE_CATEGORIES = ['TRANSACTION', 'ACCOUNT', 'CARD', 'LOAN', 'DEPOSIT', 'BUDGET', 'OFFER', 'NOTICE'] as const;

const profileSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,16}$/).nullable().optional(),
  pin: z.string().regex(/^(\d{4}|\d{6})$/),
}).strict().refine((v) => v.email !== undefined || v.phone !== undefined, { message: 'Nothing to change' });

const prefsSchema = z.object({
  defaultAccountId: z.string().uuid().nullable().optional(),
  notifications: z.partialRecord(z.enum(MUTABLE_CATEGORIES), z.boolean()).optional(),
}).strict();

const limitSchema = z.object({ dailyMinor: z.number().int().min(100).max(Number.MAX_SAFE_INTEGER), pin: z.string().regex(/^(\d{4}|\d{6})$/).optional() }).strict();

@ApiTags('me')
@Controller({ path: 'me', version: '1' })
@CustomerOnly()
export class ProfileController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pins: PinService) {}

  @Get('profile')
  async profile(@CurrentUser() u: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { customer: true } });
    const c = user.customer;
    if (!c) throw new NotFoundException({ code: 'not_found', message: 'Profile not found' });
    const addr = (c.address ?? null) as { line1?: string; city?: string; postalCode?: string } | null;
    return {
      fullName: c.fullName, customerNumber: c.customerNumber, username: user.username, email: user.email, phone: user.phone, kycStatus: c.kycStatus, memberSince: c.createdAt,
      dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : null,
      address: addr ? { line1: addr.line1 ?? '', city: addr.city ?? '', postalCode: addr.postalCode ?? '' } : null,
      nationalIdMasked: c.nationalIdEnc ? '••••••••' : null, // never decrypted or returned
      canEdit: ['email', 'phone'], // name, date of birth, ID and address are verified details: changing them is a KYC matter handled by the bank
    };
  }

  /** Contact details only, and only with the app PIN (server-verified): an attacker with a stolen session cannot redirect notices. */
  @Patch('profile')
  async update(@CurrentUser() u: AuthUser, @Body(new ZodPipe(profileSchema)) b: z.infer<typeof profileSchema>) {
    await this.pins.verify(u.id, b.pin);
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    const data: Prisma.UserUpdateInput = {};
    if (b.email !== undefined && b.email !== before.email) data.email = b.email;
    if (b.phone !== undefined && b.phone !== before.phone) data.phone = b.phone;
    if (Object.keys(data).length === 0) return this.profile(u);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: u.id }, data });
        await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'profile.contact_changed', subjectType: 'User', subjectId: u.id, metadata: { fields: Object.keys(data) } }, tx);
        await queueNotifications(tx, 'profile.changed', [{ userId: u.id, category: 'SECURITY', title: 'Contact details changed', body: `Your ${Object.keys(data).join(' and ')} on file was changed. If this was not you, change your password and contact the bank.` }]);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'already_registered', message: 'That email is already in use' });
      throw e;
    }
    return this.profile(u);
  }

  private async prefs(customerId: string) {
    const p = await this.prisma.customerPreference.findUnique({ where: { customerId } });
    const muted = new Set(p?.mutedCategories ?? []);
    return { defaultAccountId: p?.defaultAccountId ?? null, notifications: Object.fromEntries(MUTABLE_CATEGORIES.map((c) => [c, !muted.has(c)])), alwaysOn: ['SECURITY'] };
  }

  @Get('preferences') preferences(@CurrentUser() u: AuthUser) { return this.prefs(u.id); }

  @Put('preferences')
  async setPreferences(@CurrentUser() u: AuthUser, @Body(new ZodPipe(prefsSchema)) b: z.infer<typeof prefsSchema>) {
    if (b.defaultAccountId) {
      const a = await this.prisma.account.findUnique({ where: { id: b.defaultAccountId } });
      if (!a || a.customerId !== u.id) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
      if (a.status !== 'ACTIVE') throw new UnprocessableEntityException({ code: 'account_restricted', message: 'Choose an active account' });
    }
    const current = await this.prisma.customerPreference.findUnique({ where: { customerId: u.id } });
    const muted = new Set(current?.mutedCategories ?? []);
    for (const [c, on] of Object.entries(b.notifications ?? {})) { if (on) muted.delete(c); else muted.add(c); }
    await this.prisma.customerPreference.upsert({
      where: { customerId: u.id },
      create: { customerId: u.id, defaultAccountId: b.defaultAccountId ?? null, mutedCategories: [...muted] },
      update: { ...(b.defaultAccountId !== undefined ? { defaultAccountId: b.defaultAccountId } : {}), mutedCategories: [...muted] },
    });
    return this.prefs(u.id);
  }
}

@ApiTags('security')
@Controller({ path: 'security/limits', version: '1' })
@CustomerOnly({ requireActive: true })
export class LimitsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pins: PinService, @Inject(PolicyService) private readonly policy: PolicyService) {}

  private async view(customerId: string) {
    const [lim, own, used] = await Promise.all([
      this.policy.limits(),
      this.prisma.customerPreference.findUnique({ where: { customerId } }),
      this.prisma.paymentInstruction.aggregate({ _sum: { amountMinor: true }, where: { initiatorId: customerId, status: 'POSTED', kind: { notIn: ['OWN_TRANSFER', 'LOAN_INSTALMENT'] }, postedAt: { gte: startOfBankingDay(new Date()) } } }),
    ]);
    const daily = own?.dailyLimitMinor !== null && own?.dailyLimitMinor !== undefined && own.dailyLimitMinor < lim.dailyMinor ? own.dailyLimitMinor : lim.dailyMinor;
    return { dailyMinor: num(daily), bankMaximumMinor: num(lim.dailyMinor), perTransferMinor: num(lim.perTransferMinor), usedTodayMinor: num(used._sum.amountMinor ?? 0n), customised: daily < lim.dailyMinor };
  }

  @Get() get(@CurrentUser() u: AuthUser) { return this.view(u.id); }

  /** Lowering is free; raising (even back towards the bank maximum) needs the PIN. Never above what the bank allows. */
  @Put()
  async set(@CurrentUser() u: AuthUser, @Body(new ZodPipe(limitSchema)) b: z.infer<typeof limitSchema>) {
    const now = await this.view(u.id);
    if (b.dailyMinor > now.bankMaximumMinor) throw new UnprocessableEntityException({ code: 'above_bank_maximum', message: 'That is above the bank maximum', fields: { dailyMinor: 'Too high' } });
    if (b.dailyMinor === now.dailyMinor) return now;
    const raising = b.dailyMinor > now.dailyMinor;
    if (raising) {
      if (!b.pin) throw new UnprocessableEntityException({ code: 'pin_required', message: 'Enter your PIN to raise your limit', fields: { pin: 'Required' } });
      await this.pins.verify(u.id, b.pin);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.customerPreference.upsert({ where: { customerId: u.id }, create: { customerId: u.id, dailyLimitMinor: BigInt(b.dailyMinor) }, update: { dailyLimitMinor: BigInt(b.dailyMinor) } });
      await this.audit.record({ actorId: u.id, actorType: 'CUSTOMER', action: 'limits.daily_changed', subjectType: 'User', subjectId: u.id, metadata: { fromMinor: String(now.dailyMinor), toMinor: String(b.dailyMinor) } }, tx);
      await queueNotifications(tx, 'limits.changed', [{ userId: u.id, category: 'SECURITY', title: 'Daily transfer limit changed', body: `Your daily transfer limit is now LKR ${(b.dailyMinor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}.` }]);
    });
    return this.view(u.id);
  }
}
