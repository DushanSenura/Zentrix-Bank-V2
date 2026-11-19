import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { PaymentsService, type DestinationInput } from './payments.service';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DAY = 86_400_000;
const REQUEST_TTL_DAYS = 14;

type RequestRow = { id: string; reference: string; requesterId: string; payerId: string; receiveAccountId: string; amountMinor: bigint; currency: string; note: string | null; status: string; paymentId: string | null; expiresAt: Date; createdAt: Date };

/** Payment requests, saved templates and subscription detection. Money only ever moves through PaymentsService. */
@Injectable()
export class ExtrasService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly payments: PaymentsService) {}

  // ═════════════════════════ payment requests ═════════════════════════
  private view(r: RequestRow, me: string, names: Map<string, string>) {
    return { id: r.id, reference: r.reference, direction: r.requesterId === me ? 'OUTGOING' : 'INCOMING', counterpartyName: names.get(r.requesterId === me ? r.payerId : r.requesterId) ?? 'Customer', amountMinor: num(r.amountMinor), currency: r.currency, note: r.note, status: r.status, paymentId: r.paymentId, expiresAt: r.expiresAt, createdAt: r.createdAt };
  }

  private async names(ids: string[]) {
    const rows = await this.prisma.customerProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, fullName: true } });
    return new Map(rows.map((r) => [r.userId, r.fullName.split(' ')[0] ?? 'Customer']));
  }

  async createRequest(me: string, i: { receiveAccountId: string; payerAccountNumber: string; amountMinor: number; note?: string }) {
    const mine = await this.prisma.account.findUnique({ where: { id: i.receiveAccountId } });
    if (!mine || mine.customerId !== me) {
      if (mine) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', me, { resource: 'Account', id: i.receiveAccountId });
      throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    }
    if (mine.status !== 'ACTIVE') throw new ConflictException({ code: 'account_restricted', message: 'That account cannot receive money right now' });
    const payerAcc = await this.prisma.account.findUnique({ where: { accountNumber: i.payerAccountNumber } });
    if (!payerAcc || payerAcc.status !== 'ACTIVE') throw new NotFoundException({ code: 'payer_not_found', message: 'We could not find that account' });
    if (payerAcc.customerId === me) throw new BadRequestException({ code: 'self_request', message: 'You cannot request money from yourself' });
    const reference = `PR${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
    const requester = await this.prisma.customerProfile.findUniqueOrThrow({ where: { userId: me } });
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.paymentRequest.create({ data: { reference, requesterId: me, payerId: payerAcc.customerId, receiveAccountId: mine.id, amountMinor: BigInt(i.amountMinor), note: i.note ?? null, expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * DAY) } });
      await queueNotifications(tx, 'payment_request.created', [{ userId: payerAcc.customerId, category: 'TRANSACTION', title: 'Payment request', body: `${requester.fullName} requested ${lkr(r.amountMinor)}${i.note ? ` for "${i.note}"` : ''}. Open the app to pay or decline.` }]);
      return r;
    });
    return this.view(row, me, new Map([[payerAcc.customerId, 'Customer']]));
  }

  /** Lazy maintenance: expire stale requests, and mark PAID once the linked payment has posted. */
  private async sync(me: string) {
    await this.prisma.paymentRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() }, paymentId: null, OR: [{ requesterId: me }, { payerId: me }] }, data: { status: 'EXPIRED' } });
    const linked = await this.prisma.paymentRequest.findMany({ where: { status: 'PENDING', paymentId: { not: null }, OR: [{ requesterId: me }, { payerId: me }] } });
    for (const r of linked) {
      const p = await this.prisma.paymentInstruction.findUnique({ where: { id: r.paymentId! }, select: { status: true } });
      if (p?.status === 'POSTED') await this.prisma.paymentRequest.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'PAID' } });
    }
  }

  async listRequests(me: string) {
    await this.sync(me);
    const rows = await this.prisma.paymentRequest.findMany({ where: { OR: [{ requesterId: me }, { payerId: me }] }, orderBy: { createdAt: 'desc' }, take: 100 });
    const names = await this.names([...new Set(rows.flatMap((r) => [r.requesterId, r.payerId]))]);
    return { items: rows.map((r) => this.view(r, me, names)) };
  }

  private async mine(me: string, id: string, role: 'payer' | 'requester') {
    await this.sync(me);
    const r = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!r || (role === 'payer' ? r.payerId : r.requesterId) !== me) {
      if (r) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', me, { resource: 'PaymentRequest', id });
      throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
    }
    return r;
  }

  /** Creates the draft payment for the payer; they still confirm it with their PIN like any other payment. */
  async pay(me: string, id: string, key: string, sourceAccountId: string) {
    const r = await this.mine(me, id, 'payer');
    if (r.status !== 'PENDING') throw new ConflictException({ code: 'request_closed', message: `This request is ${r.status.toLowerCase()}` });
    const dest = await this.prisma.account.findUniqueOrThrow({ where: { id: r.receiveAccountId } });
    const { body } = await this.payments.create(me, key, { sourceAccountId, destination: { type: 'ZENTRIX', accountNumber: dest.accountNumber } as DestinationInput, amountMinor: num(r.amountMinor), note: r.note ?? `Request ${r.reference}` });
    await this.prisma.paymentRequest.updateMany({ where: { id, status: 'PENDING' }, data: { paymentId: body.id } });
    return { payment: body };
  }

  decline(me: string, id: string) { return this.close(me, id, 'payer', 'DECLINED', 'Request declined', 'declined'); }
  cancelRequest(me: string, id: string) { return this.close(me, id, 'requester', 'CANCELLED', 'Request cancelled', 'cancelled'); }

  private async close(me: string, id: string, role: 'payer' | 'requester', status: string, title: string, verb: string) {
    const r = await this.mine(me, id, role);
    if (r.status !== 'PENDING') throw new ConflictException({ code: 'request_closed', message: `This request is ${r.status.toLowerCase()}` });
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.paymentRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status } });
      if (n.count === 0) throw new ConflictException({ code: 'request_closed', message: 'This request was just updated' });
      await queueNotifications(tx, `payment_request.${verb}`, [{ userId: role === 'payer' ? r.requesterId : r.payerId, category: 'TRANSACTION', title, body: `Request ${r.reference} for ${lkr(r.amountMinor)} was ${verb}.` }]);
    });
  }

  // ═════════════════════════ templates ═════════════════════════
  private tpl(t: { id: string; name: string; sourceAccountId: string | null; destination: Prisma.JsonValue; amountMinor: bigint | null; note: string | null }) {
    return { id: t.id, name: t.name, sourceAccountId: t.sourceAccountId, destination: t.destination, amountMinor: t.amountMinor === null ? null : num(t.amountMinor), note: t.note };
  }

  async listTemplates(me: string) { return { items: (await this.prisma.paymentTemplate.findMany({ where: { customerId: me }, orderBy: { name: 'asc' } })).map((t) => this.tpl(t)) }; }

  async createTemplate(me: string, i: { name: string; sourceAccountId?: string; destination: DestinationInput; amountMinor?: number; note?: string }) {
    if (i.sourceAccountId) {
      const a = await this.prisma.account.findUnique({ where: { id: i.sourceAccountId } });
      if (!a || a.customerId !== me) throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    }
    if ((await this.prisma.paymentTemplate.count({ where: { customerId: me } })) >= 30) throw new ConflictException({ code: 'too_many', message: 'You can save up to 30 templates' });
    try {
      return this.tpl(await this.prisma.paymentTemplate.create({ data: { customerId: me, name: i.name, sourceAccountId: i.sourceAccountId ?? null, destination: i.destination as unknown as Prisma.InputJsonValue, amountMinor: i.amountMinor === undefined ? null : BigInt(i.amountMinor), note: i.note ?? null } }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'duplicate_name', message: 'You already have a template with that name' });
      throw e;
    }
  }

  async deleteTemplate(me: string, id: string) {
    const t = await this.prisma.paymentTemplate.findUnique({ where: { id } });
    if (!t || t.customerId !== me) {
      if (t) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', me, { resource: 'PaymentTemplate', id });
      throw new NotFoundException({ code: 'not_found', message: 'Template not found' });
    }
    await this.prisma.paymentTemplate.delete({ where: { id } });
  }

  // ═════════════════════════ subscriptions (read-only detection) ═════════════════════════
  /** Same recipient and amount, at least 3 completed payments roughly a week or a month apart. */
  async subscriptions(me: string) {
    const since = new Date(Date.now() - 200 * DAY);
    const rows = await this.prisma.paymentInstruction.findMany({ where: { initiatorId: me, status: 'POSTED', postedAt: { gte: since } }, orderBy: { postedAt: 'asc' }, take: 1000 });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const d = (r.destination ?? {}) as Record<string, unknown>;
      const who = String(d.billerCode ?? d.accountNumber ?? d.toAccountId ?? d.name ?? '');
      if (!who) continue;
      const k = `${who}|${r.amountMinor}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const items: { name: string; amountMinor: number; frequency: 'WEEKLY' | 'MONTHLY'; occurrences: number; lastPaidAt: Date; nextExpectedAt: Date; annualCostMinor: number }[] = [];
    for (const list of groups.values()) {
      if (list.length < 3) continue;
      const gaps = list.slice(1).map((r, i) => (r.postedAt!.getTime() - list[i]!.postedAt!.getTime()) / DAY);
      const weekly = gaps.every((g) => g >= 5 && g <= 9);
      const monthly = gaps.every((g) => g >= 26 && g <= 35);
      if (!weekly && !monthly) continue;
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const last = list[list.length - 1]!;
      const d = (last.destination ?? {}) as Record<string, unknown>;
      items.push({ name: String(d.billerName ?? d.name ?? d.billerCode ?? 'Recipient'), amountMinor: num(last.amountMinor), frequency: weekly ? 'WEEKLY' : 'MONTHLY', occurrences: list.length, lastPaidAt: last.postedAt!, nextExpectedAt: new Date(last.postedAt!.getTime() + Math.round(avg) * DAY), annualCostMinor: num(last.amountMinor) * (weekly ? 52 : 12) });
    }
    return { items: items.sort((a, b) => b.annualCostMinor - a.annualCostMinor), note: 'Detected from your payment history. This is informational only.' };
  }
}
