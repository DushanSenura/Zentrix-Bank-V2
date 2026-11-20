import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type Card, type CardControls, type CardKind, type CardStatus } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { hashSecret, verifySecret } from '../../security/password';
import { randomToken } from '../../security/crypto';
import { num } from '../accounts/accounts.service';
import { PinService } from '../auth/pin.service';

const DEBIT_PREP_DAYS = 5; // V1 rule: the bank prepares a debit card for 5 days
const MAX_VIRTUAL = 3;
const DEFAULT_MAX_DAILY_LIMIT = 50_000_000; // LKR 500,000; override with SystemConfiguration "cards.maxDailyLimitMinor"
const IN_FLIGHT: CardStatus[] = ['PENDING_APPROVAL', 'PREPARING', 'READY_TO_COLLECT'];

export interface CardRequest {
  kind: CardKind;
  accountId: string;
  pin: string;
  collectionBranchId?: string;
  application?: { monthlyIncomeMinor: number; employment: string; requestedLimitMinor: number };
  replacementFor?: string;
}

const STATUS_TEXT: Record<CardStatus, string> = {
  PENDING_APPROVAL: 'Awaiting bank approval',
  PREPARING: 'Being prepared',
  READY_TO_COLLECT: 'Ready to collect',
  ACTIVE: 'Active',
  FROZEN: 'Frozen',
  BLOCKED: 'Blocked',
  REJECTED: 'Not approved',
};

type CardRow = Card & { controls: CardControls | null };

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pins: PinService) {}

  private async maxDailyLimit(): Promise<bigint> {
    const c = await this.prisma.systemConfiguration.findUnique({ where: { key: 'cards.maxDailyLimitMinor' } });
    return BigInt(typeof c?.value === 'number' ? c.value : DEFAULT_MAX_DAILY_LIMIT);
  }

  /** Never exposes a card number, CVV, PIN hash or issuer token: only the last four digits. */
  private view(c: CardRow, branchName?: string | null, maxLimit?: bigint) {
    return {
      id: c.id,
      kind: c.kind,
      network: c.network,
      status: c.status,
      statusText: STATUS_TEXT[c.status],
      holderName: c.holderName,
      maskedNumber: c.last4 ? `•••• •••• •••• ${c.last4}` : null,
      expiry: c.expiryMonth && c.expiryYear ? `${String(c.expiryMonth).padStart(2, '0')}/${String(c.expiryYear).slice(-2)}` : null,
      accountId: c.accountId,
      readyOn: c.readyOn?.toISOString() ?? null,
      collectionBranch: branchName ?? null,
      creditLimitMinor: c.creditLimitMinor === null ? null : num(c.creditLimitMinor),
      decisionReason: c.status === 'REJECTED' ? c.decisionReason : null,
      createdAt: c.createdAt.toISOString(),
      controls: c.controls ? { dailyLimitMinor: num(c.controls.dailyLimitMinor), maxDailyLimitMinor: maxLimit === undefined ? undefined : num(maxLimit), onlineEnabled: c.controls.onlineEnabled, internationalEnabled: c.controls.internationalEnabled, contactlessEnabled: c.controls.contactlessEnabled } : null,
    };
  }

  private async branchNames(ids: (string | null)[]) {
    const real = ids.filter((x): x is string => !!x);
    const rows = real.length ? await this.prisma.branch.findMany({ where: { id: { in: real } } }) : [];
    return new Map(rows.map((b) => [b.id, `${b.name}, ${b.city}`]));
  }

  async list(customerId: string) {
    const [rows, max] = await Promise.all([this.prisma.card.findMany({ where: { customerId }, include: { controls: true }, orderBy: { createdAt: 'desc' } }), this.maxDailyLimit()]);
    const names = await this.branchNames(rows.map((r) => r.collectionBranchId));
    return { items: rows.map((r) => this.view(r, r.collectionBranchId ? names.get(r.collectionBranchId) : null, max)) };
  }

  private async owned(customerId: string, id: string): Promise<CardRow> {
    const c = await this.prisma.card.findUnique({ where: { id }, include: { controls: true } });
    if (!c || c.customerId !== customerId) {
      if (c) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Card', id });
      throw new NotFoundException({ code: 'not_found', message: 'Card not found' });
    }
    return c;
  }

  async detail(customerId: string, id: string) {
    const c = await this.owned(customerId, id);
    const names = await this.branchNames([c.collectionBranchId]);
    return this.view(c, c.collectionBranchId ? names.get(c.collectionBranchId) : null, await this.maxDailyLimit());
  }

  async history(customerId: string, id: string) {
    await this.owned(customerId, id);
    const rows = await this.prisma.cardStatusHistory.findMany({ where: { cardId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: rows.map((h) => ({ from: h.fromStatus, to: h.toStatus, reason: h.reasonCode, at: h.createdAt })) };
  }

  private async setStatus(tx: Prisma.TransactionClient, id: string, from: CardStatus[], to: CardStatus, reasonCode: string, actorId: string | null, extra: Prisma.CardUpdateManyMutationInput = {}): Promise<boolean> {
    const cur = await tx.card.findUnique({ where: { id }, select: { status: true } });
    const r = await tx.card.updateMany({ where: { id, status: { in: from } }, data: { status: to, ...extra } });
    if (r.count !== 1) return false;
    await tx.cardStatusHistory.create({ data: { cardId: id, fromStatus: cur?.status ?? null, toStatus: to, reasonCode, actorId } });
    return true;
  }

  // ───────────────────────── customer: request ─────────────────────────
  async request(customerId: string, r: CardRequest) {
    await this.pins.verify(customerId, r.pin);
    const acc = await this.prisma.account.findUnique({ where: { id: r.accountId } });
    if (!acc || acc.customerId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    if (acc.status !== 'ACTIVE') throw new ConflictException({ code: 'account_restricted', message: 'The linked account must be active' });
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({ where: { userId: customerId } });

    if (r.kind === 'DEBIT' || r.kind === 'CREDIT') {
      const inflight = await this.prisma.card.count({ where: { customerId, kind: r.kind, status: { in: IN_FLIGHT } } });
      if (inflight > 0) throw new ConflictException({ code: 'request_in_progress', message: `You already have a ${r.kind.toLowerCase()} card on its way` });
    }
    if (r.kind === 'DEBIT') {
      const branch = r.collectionBranchId ? await this.prisma.branch.findFirst({ where: { id: r.collectionBranchId, active: true, type: 'BRANCH' } }) : null;
      if (!branch) throw new BadRequestException({ code: 'validation_failed', message: 'Choose a branch to collect from', fields: { collectionBranchId: 'Required' } });
    }
    if (r.kind === 'VIRTUAL') {
      const n = await this.prisma.card.count({ where: { customerId, kind: 'VIRTUAL', status: { in: [...IN_FLIGHT, 'ACTIVE', 'FROZEN'] } } });
      if (n >= MAX_VIRTUAL) throw new ConflictException({ code: 'card_limit', message: `You can have at most ${MAX_VIRTUAL} virtual cards` });
    }
    if (r.kind === 'CREDIT' && !r.application) throw new BadRequestException({ code: 'validation_failed', message: 'A credit card application needs your income and employment details', fields: { application: 'Required' } });

    const card = await this.prisma.$transaction(async (tx) => {
      const c = await tx.card.create({
        data: {
          customerId, accountId: acc.id, kind: r.kind, holderName: profile.fullName.toUpperCase().slice(0, 26), collectionBranchId: r.kind === 'DEBIT' ? r.collectionBranchId : null,
          application: r.application || r.replacementFor ? ({ ...r.application, ...(r.replacementFor ? { replacementFor: r.replacementFor } : {}) } as Prisma.InputJsonValue) : undefined,
          creditLimitMinor: null,
          controls: { create: {} },
          history: { create: { toStatus: 'PENDING_APPROVAL', reasonCode: r.replacementFor ? 'REPLACEMENT_REQUESTED' : 'REQUESTED', actorId: customerId } },
        },
        include: { controls: true },
      });
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'card.requested', subjectType: 'Card', subjectId: c.id, metadata: { kind: r.kind } }, tx);
      return c;
    });
    return this.view(card);
  }

  // ───────────────────────── customer: lifecycle ─────────────────────────
  /** Debit/credit cards: the customer activates with the app PIN AFTER collecting the card, choosing the card PIN. */
  async activate(customerId: string, id: string, appPin: string, cardPin: string) {
    const c = await this.owned(customerId, id);
    if (c.kind === 'VIRTUAL') throw new ConflictException({ code: 'bank_activation_only', message: 'Virtual cards are activated by the bank when approved' });
    if (c.status !== 'READY_TO_COLLECT') throw new ConflictException({ code: 'not_ready', message: 'This card is not ready to activate yet' });
    if (!/^\d{4}$/.test(cardPin) || /^(\d)\1{3}$/.test(cardPin)) throw new BadRequestException({ code: 'weak_pin', message: 'Choose a 4-digit card PIN that is not all the same digit', fields: { cardPin: 'Too easy to guess' } });
    await this.pins.verify(customerId, appPin);
    const pinHash = await hashSecret(cardPin); // simulated issuer HSM
    const ok = await this.prisma.$transaction(async (tx) => {
      const done = await this.setStatus(tx, id, ['READY_TO_COLLECT'], 'ACTIVE', 'ACTIVATED_BY_CUSTOMER', customerId, { pinHash, activatedAt: new Date() });
      if (done) await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'card.activated', subjectType: 'Card', subjectId: id }, tx);
      return done;
    });
    if (!ok) throw new ConflictException({ code: 'not_ready', message: 'This card is not ready to activate yet' });
    return this.detail(customerId, id);
  }

  async freeze(customerId: string, id: string, frozen: boolean) {
    await this.owned(customerId, id);
    const ok = await this.prisma.$transaction(async (tx) => {
      const done = await this.setStatus(tx, id, frozen ? ['ACTIVE'] : ['FROZEN'], frozen ? 'FROZEN' : 'ACTIVE', frozen ? 'FROZEN_BY_CUSTOMER' : 'UNFROZEN_BY_CUSTOMER', customerId);
      if (done) {
        await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: frozen ? 'card.frozen' : 'card.unfrozen', subjectType: 'Card', subjectId: id }, tx);
        const c = await tx.card.findUniqueOrThrow({ where: { id } });
        await queueNotifications(tx, 'card.status_changed', [{ userId: customerId, category: 'CARD', title: frozen ? 'Card frozen' : 'Card unfrozen', body: `Your card ending ${c.last4} was ${frozen ? 'frozen' : 'unfrozen'}.` }]);
      }
      return done;
    });
    if (!ok) throw new ConflictException({ code: 'invalid_state', message: frozen ? 'Only an active card can be frozen' : 'This card is not frozen' });
    return this.detail(customerId, id);
  }

  /** Tightening a control is free; LOOSENING one (higher limit, switching a capability on) needs the app PIN. */
  async setControls(customerId: string, id: string, d: { dailyLimitMinor?: number; onlineEnabled?: boolean; internationalEnabled?: boolean; contactlessEnabled?: boolean; pin?: string }) {
    const c = await this.owned(customerId, id);
    if (c.status !== 'ACTIVE' && c.status !== 'FROZEN') throw new ConflictException({ code: 'invalid_state', message: 'Controls can only be changed on an active or frozen card' });
    const cur = c.controls!;
    const max = await this.maxDailyLimit();
    if (d.dailyLimitMinor !== undefined && BigInt(d.dailyLimitMinor) > max) throw new UnprocessableEntityException({ code: 'limit_exceeded', message: `The daily card limit cannot exceed ${lkr(max)}`, fields: { dailyLimitMinor: 'Above the bank maximum' } });
    const loosening = (d.dailyLimitMinor !== undefined && BigInt(d.dailyLimitMinor) > cur.dailyLimitMinor) || (d.onlineEnabled === true && !cur.onlineEnabled) || (d.internationalEnabled === true && !cur.internationalEnabled) || (d.contactlessEnabled === true && !cur.contactlessEnabled);
    if (loosening) {
      if (!d.pin) throw new BadRequestException({ code: 'pin_required', message: 'Enter your PIN to raise a limit or switch a feature on', fields: { pin: 'Required' } });
      await this.pins.verify(customerId, d.pin);
    }
    await this.prisma.cardControls.update({ where: { cardId: id }, data: { ...(d.dailyLimitMinor !== undefined ? { dailyLimitMinor: BigInt(d.dailyLimitMinor) } : {}), ...(d.onlineEnabled !== undefined ? { onlineEnabled: d.onlineEnabled } : {}), ...(d.internationalEnabled !== undefined ? { internationalEnabled: d.internationalEnabled } : {}), ...(d.contactlessEnabled !== undefined ? { contactlessEnabled: d.contactlessEnabled } : {}) } });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'card.controls_changed', subjectType: 'Card', subjectId: id, metadata: { loosening } });
    return this.detail(customerId, id);
  }

  /** Permanently blocks the card and (for physical cards) orders a replacement through the normal approval queue. */
  async reportLost(customerId: string, id: string, pin: string) {
    const c = await this.owned(customerId, id);
    await this.pins.verify(customerId, pin);
    const result = await this.prisma.$transaction(async (tx) => {
      const done = await this.setStatus(tx, id, ['ACTIVE', 'FROZEN', 'READY_TO_COLLECT', 'PREPARING'], 'BLOCKED', 'REPORTED_LOST', customerId);
      if (!done) return { ok: false as const, replacement: null };
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'card.reported_lost', subjectType: 'Card', subjectId: id }, tx);
      await queueNotifications(tx, 'card.blocked', [{ userId: customerId, category: 'CARD', title: 'Card blocked', body: `Your card ending ${c.last4 ?? '----'} was permanently blocked.${c.kind === 'VIRTUAL' ? '' : ' A replacement has been requested.'}` }]);
      let replacement: { id: string } | null = null;
      if (c.kind !== 'VIRTUAL') {
        replacement = await tx.card.create({ data: { customerId, accountId: c.accountId, kind: c.kind, holderName: c.holderName, collectionBranchId: c.collectionBranchId, creditLimitMinor: null, application: { replacementFor: id } as Prisma.InputJsonValue, controls: { create: {} }, history: { create: { toStatus: 'PENDING_APPROVAL', reasonCode: 'REPLACEMENT_REQUESTED', actorId: customerId } } } });
      }
      return { ok: true as const, replacement };
    });
    if (!result.ok) throw new ConflictException({ code: 'invalid_state', message: 'This card cannot be reported lost in its current state' });
    return { blocked: true, replacementId: result.replacement?.id ?? null };
  }

  /** The customer's own "block this card for good": permanent, no replacement is ordered (use report-lost for that). */
  async blockPermanently(customerId: string, id: string, pin: string) {
    const c = await this.owned(customerId, id);
    await this.pins.verify(customerId, pin);
    const done = await this.prisma.$transaction(async (tx) => {
      const ok = await this.setStatus(tx, id, ['ACTIVE', 'FROZEN', 'READY_TO_COLLECT', 'PREPARING'], 'BLOCKED', 'BLOCKED_BY_CUSTOMER', customerId);
      if (!ok) return false;
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'card.blocked_by_customer', subjectType: 'Card', subjectId: id }, tx);
      await queueNotifications(tx, 'card.blocked', [{ userId: customerId, category: 'CARD', title: 'Card blocked', body: `Your card ending ${c.last4 ?? '----'} was permanently blocked at your request.` }]);
      return true;
    });
    if (!done) throw new ConflictException({ code: 'invalid_state', message: 'This card cannot be blocked in its current state' });
    return { blocked: true };
  }

  /** Simulated issuer PIN change: verified against the issuer hash, never stored or logged in clear. */
  async changeCardPin(customerId: string, id: string, currentPin: string, newPin: string) {
    const c = await this.owned(customerId, id);
    if (c.status !== 'ACTIVE' || !c.pinHash) throw new ConflictException({ code: 'invalid_state', message: 'Only an active card has a PIN' });
    if (!(await verifySecret(c.pinHash, currentPin))) {
      await this.audit.securityEvent('CARD_PIN_WRONG', customerId, { cardId: id });
      throw new UnauthorizedException({ code: 'invalid_card_pin', message: 'Incorrect card PIN' });
    }
    if (!/^\d{4}$/.test(newPin) || /^(\d)\1{3}$/.test(newPin)) throw new BadRequestException({ code: 'weak_pin', message: 'Choose a 4-digit card PIN that is not all the same digit', fields: { newPin: 'Too easy to guess' } });
    await this.prisma.card.update({ where: { id }, data: { pinHash: await hashSecret(newPin) } });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'card.pin_changed', subjectType: 'Card', subjectId: id });
  }

  // ───────────────────────── staff ─────────────────────────
  async queue(status: string) {
    const s = (['PENDING_APPROVAL', 'PREPARING', 'READY_TO_COLLECT', 'ACTIVE', 'FROZEN', 'BLOCKED', 'REJECTED'] as const).find((x) => x === status) ?? 'PENDING_APPROVAL';
    const rows = await this.prisma.card.findMany({ where: { status: s }, orderBy: { createdAt: 'asc' }, take: 100 });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    const names = await this.branchNames(rows.map((r) => r.collectionBranchId));
    return {
      items: rows.map((r) => ({
        id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt, customerName: customers.get(r.customerId)?.fullName, customerNumber: customers.get(r.customerId)?.customerNumber,
        collectionBranch: r.collectionBranchId ? names.get(r.collectionBranchId) : null, application: r.application, last4: r.last4, replacement: !!(r.application as { replacementFor?: string } | null)?.replacementFor,
      })),
    };
  }

  async decide(staffId: string, id: string, d: { decision: 'APPROVE' | 'REJECT'; reason?: string; creditLimitMinor?: number }) {
    if (d.decision === 'REJECT' && !d.reason) throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { reason: 'Required' } });
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.card.findUnique({ where: { id } });
      if (!c) throw new NotFoundException({ code: 'not_found', message: 'Card not found' });
      if (d.decision === 'APPROVE' && c.kind === 'CREDIT' && !(d.creditLimitMinor && d.creditLimitMinor > 0)) throw new BadRequestException({ code: 'credit_limit_required', message: 'Set a credit limit to approve a credit card', fields: { creditLimitMinor: 'Required' } });

      let ok: boolean;
      if (d.decision === 'REJECT') {
        ok = await this.setStatus(tx, id, ['PENDING_APPROVAL'], 'REJECTED', 'REJECTED_BY_BANK', staffId, { decisionReason: d.reason, decidedById: staffId, decidedAt: new Date() });
      } else {
        // The issuer (simulated) assigns identifiers. No full number or CVV is ever generated or stored.
        const issued = { token: `tok_${randomToken(18)}`, last4: String(randomInt(0, 10000)).padStart(4, '0'), expiryMonth: new Date().getUTCMonth() + 1, expiryYear: new Date().getUTCFullYear() + (c.kind === 'VIRTUAL' ? 3 : 4) };
        const virtual = c.kind === 'VIRTUAL';
        ok = await this.setStatus(tx, id, ['PENDING_APPROVAL'], virtual ? 'ACTIVE' : 'PREPARING', virtual ? 'APPROVED_ACTIVATED_BY_BANK' : 'APPROVED_PREPARING', staffId, {
          ...issued, decidedById: staffId, decidedAt: new Date(), ...(virtual ? { activatedAt: new Date() } : { readyOn: new Date(Date.now() + DEBIT_PREP_DAYS * 86_400_000) }),
          ...(c.kind === 'CREDIT' ? { creditLimitMinor: BigInt(d.creditLimitMinor!) } : {}),
        });
        if (ok) await queueNotifications(tx, 'card.approved', [{ userId: c.customerId, category: 'CARD', title: virtual ? 'Virtual card ready' : 'Card approved', body: virtual ? `Your virtual card ending ${issued.last4} is active.` : `Your ${c.kind.toLowerCase()} card is being prepared. We will tell you when it is ready to collect.` }]);
      }
      if (!ok) throw new ConflictException({ code: 'not_reviewable', message: 'This request was already decided' });
      if (d.decision === 'REJECT') await queueNotifications(tx, 'card.rejected', [{ userId: c.customerId, category: 'CARD', title: 'Card request not approved', body: d.reason! }]);
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: `card.${d.decision.toLowerCase()}`, subjectType: 'Card', subjectId: id, reasonCode: d.reason?.slice(0, 100) }, tx);
      return { id, status: (await tx.card.findUniqueOrThrow({ where: { id } })).status };
    });
  }

  async block(staffId: string, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.card.findUnique({ where: { id } });
      if (!c) throw new NotFoundException({ code: 'not_found', message: 'Card not found' });
      const ok = await this.setStatus(tx, id, ['PREPARING', 'READY_TO_COLLECT', 'ACTIVE', 'FROZEN', 'PENDING_APPROVAL'], 'BLOCKED', 'BLOCKED_BY_BANK', staffId, { decisionReason: reason });
      if (!ok) throw new ConflictException({ code: 'invalid_state', message: 'This card cannot be blocked in its current state' });
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'card.blocked_by_bank', subjectType: 'Card', subjectId: id, reasonCode: reason.slice(0, 100) }, tx);
      await queueNotifications(tx, 'card.blocked', [{ userId: c.customerId, category: 'CARD', title: 'Card blocked', body: `Your card ending ${c.last4 ?? '----'} was blocked by the bank. Please contact support.` }]);
      return { id, status: 'BLOCKED' as const };
    });
  }

  /** Job: debit/credit cards whose preparation time has passed become READY_TO_COLLECT. Idempotent. */
  async runDue(now: Date): Promise<number> {
    const due = await this.prisma.card.findMany({ where: { status: 'PREPARING', readyOn: { lte: now } }, select: { id: true } });
    let n = 0;
    for (const { id } of due) {
      await this.prisma.$transaction(async (tx) => {
        if (!(await this.setStatus(tx, id, ['PREPARING'], 'READY_TO_COLLECT', 'PREPARED', null))) return;
        const c = await tx.card.findUniqueOrThrow({ where: { id } });
        const branch = c.collectionBranchId ? await tx.branch.findUnique({ where: { id: c.collectionBranchId } }) : null;
        await queueNotifications(tx, 'card.ready', [{ userId: c.customerId, category: 'CARD', title: 'Card ready to collect', body: `Your card ending ${c.last4} is ready${branch ? ` at ${branch.name}, ${branch.city}` : ''}. Bring your ID, then activate it in the app.` }]);
        n++;
      });
    }
    return n;
  }

  async branches() {
    const rows = await this.prisma.branch.findMany({ where: { active: true }, orderBy: [{ city: 'asc' }, { name: 'asc' }] });
    return { items: rows.map((b) => ({ id: b.id, code: b.code, name: b.name, city: b.city, address: b.address, type: b.type, latitude: b.latitude, longitude: b.longitude })) };
  }
}
