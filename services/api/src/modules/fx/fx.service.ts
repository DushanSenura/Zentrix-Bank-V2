import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { ENV, type Env } from '../../config/env';
import { num } from '../accounts/accounts.service';
import { PinService } from '../auth/pin.service';
import { LedgerRejection, LedgerService } from '../ledger/ledger.service';
import { PolicyService } from '../payments/policy.service';

export const FX_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type FxCurrency = (typeof FX_CURRENCIES)[number];
/** Fictional starting rates (LKR per 1 unit, times 1e6). Staff change them in the portal. */
export const DEFAULT_MID_MICRO: Record<FxCurrency, bigint> = { USD: 320_000_000n, EUR: 350_000_000n, GBP: 410_000_000n };
export const DEFAULT_SPREAD_BPS = 150;
const MICRO = 1_000_000n;
const QUOTE_TTL_MS = 60_000;

/** LKR -> foreign: customer BUYS the currency, so the bank's rate is worse for them (mid plus spread). Rounds down: never in the customer's favour. */
export function buyForeign(lkrMinor: bigint, midMicro: bigint, spreadBps: number): { toMinor: bigint; rateMicro: bigint } {
  const rateMicro = (midMicro * BigInt(10_000 + spreadBps)) / 10_000n;
  return { toMinor: (lkrMinor * MICRO) / rateMicro, rateMicro };
}
/** Foreign -> LKR: customer SELLS, mid minus spread. */
export function sellForeign(foreignMinor: bigint, midMicro: bigint, spreadBps: number): { toMinor: bigint; rateMicro: bigint } {
  const rateMicro = (midMicro * BigInt(10_000 - spreadBps)) / 10_000n;
  return { toMinor: (foreignMinor * rateMicro) / MICRO, rateMicro };
}

interface QuotePayload { c: string; f: string; t: string; a: string; o: string; r: string; fc: string; tc: string; exp: number }

@Injectable()
export class FxService {
  private readonly key: Buffer;
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly ledger: LedgerService, private readonly pins: PinService,
    private readonly policy: PolicyService, @Inject(ENV) env: Env,
  ) {
    this.key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
  }

  // ───────────────────────── rates ─────────────────────────
  async spreadBps(): Promise<number> {
    const row = await this.prisma.systemConfiguration.findUnique({ where: { key: 'fx.spreadBps' } });
    return typeof row?.value === 'number' && Number.isInteger(row.value) && row.value >= 0 && row.value <= 1000 ? row.value : DEFAULT_SPREAD_BPS;
  }

  async mid(currency: string): Promise<bigint> {
    if (!(FX_CURRENCIES as readonly string[]).includes(currency)) throw new UnprocessableEntityException({ code: 'unsupported_currency', message: 'That currency is not supported' });
    return (await this.prisma.fxRate.findUnique({ where: { currency } }))?.midRateMicro ?? DEFAULT_MID_MICRO[currency as FxCurrency];
  }

  async rates() {
    const [spread, rows] = await Promise.all([this.spreadBps(), this.prisma.fxRate.findMany()]);
    const by = new Map(rows.map((r) => [r.currency, r]));
    return {
      spreadBps: spread, base: 'LKR',
      items: FX_CURRENCIES.map((c) => {
        const mid = by.get(c)?.midRateMicro ?? DEFAULT_MID_MICRO[c];
        return { currency: c, midRate: Number(mid) / 1e6, youPayPerUnit: Number(buyForeign(100n, mid, spread).rateMicro) / 1e6, youGetPerUnit: Number(sellForeign(100n, mid, spread).rateMicro) / 1e6, updatedAt: by.get(c)?.updatedAt ?? null };
      }),
      note: 'Indicative simulated rates set by the bank. You always see the exact rate and amount before you confirm.',
    };
  }

  async setRate(staffId: string, currency: string, midRate: number) {
    if (!(FX_CURRENCIES as readonly string[]).includes(currency)) throw new UnprocessableEntityException({ code: 'unsupported_currency', message: 'That currency is not supported' });
    const micro = BigInt(Math.round(midRate * 1e6));
    const before = await this.mid(currency);
    // A fat-finger guard: no single change may move a rate by more than 20 percent.
    if (micro <= 0n || micro > (before * 120n) / 100n || micro < (before * 80n) / 100n) throw new UnprocessableEntityException({ code: 'rate_change_too_large', message: 'A rate cannot change by more than 20 percent at once. Check the figure.' });
    await this.prisma.$transaction(async (tx) => {
      await tx.fxRate.upsert({ where: { currency }, update: { midRateMicro: micro, updatedBy: staffId }, create: { currency, midRateMicro: micro, updatedBy: staffId } });
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'fx.rate_changed', subjectType: 'FxRate', subjectId: currency, metadata: { fromMicro: before.toString(), toMicro: micro.toString() } }, tx);
    });
    return this.rates();
  }

  // ───────────────────────── quotes ─────────────────────────
  private sign(p: QuotePayload): string {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  private verify(token: string, customerId: string): QuotePayload {
    const bad = new UnprocessableEntityException({ code: 'invalid_quote', message: 'This quote is not valid. Please get a new one.' });
    const [body, sig] = token.split('.');
    if (!body || !sig) throw bad;
    const expect = createHmac('sha256', this.key).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw bad;
    let p: QuotePayload;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString()) as QuotePayload; } catch { throw bad; }
    if (p.c !== customerId) throw bad;
    if (p.exp < Date.now()) throw new UnprocessableEntityException({ code: 'quote_expired', message: 'This quote has expired. Please get a new one.' });
    return p;
  }

  private async accounts(customerId: string, fromId: string, toId: string) {
    const [from, to] = await Promise.all([this.prisma.account.findUnique({ where: { id: fromId }, include: { ledgerAccount: true } }), this.prisma.account.findUnique({ where: { id: toId }, include: { ledgerAccount: true } })]);
    for (const [a, id] of [[from, fromId], [to, toId]] as const) {
      if (!a || a.customerId !== customerId) {
        if (a) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Account', id });
        throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
      }
      if (a.status !== 'ACTIVE' || !a.ledgerAccount) throw new UnprocessableEntityException({ code: 'account_restricted', message: 'Both accounts must be active' });
    }
    if (from!.id === to!.id || from!.currency === to!.currency) throw new BadRequestException({ code: 'same_currency', message: 'Choose accounts in two different currencies' });
    if (from!.currency !== 'LKR' && to!.currency !== 'LKR') throw new UnprocessableEntityException({ code: 'via_lkr', message: 'Exchange goes through rupees: move one currency to LKR first.' });
    return { from: from!, to: to! };
  }

  async quote(customerId: string, i: { fromAccountId: string; toAccountId: string; amountMinor: number }) {
    const { from, to } = await this.accounts(customerId, i.fromAccountId, i.toAccountId);
    const amount = BigInt(i.amountMinor);
    const spread = await this.spreadBps();
    const buying = from.currency === 'LKR'; // the customer buys foreign currency with rupees
    const foreign = buying ? to.currency : from.currency;
    const mid = await this.mid(foreign);
    const r = buying ? buyForeign(amount, mid, spread) : sellForeign(amount, mid, spread);
    if (r.toMinor <= 0n) throw new UnprocessableEntityException({ code: 'amount_too_small', message: 'That amount is too small to exchange' });
    const lkrSide = buying ? amount : r.toMinor;
    const lim = await this.policy.limits(customerId);
    if (lkrSide > lim.perTransferMinor) throw new UnprocessableEntityException({ code: 'limit_exceeded', message: 'That is above the limit for a single exchange' });
    const exp = Date.now() + QUOTE_TTL_MS;
    const token = this.sign({ c: customerId, f: from.id, t: to.id, a: amount.toString(), o: r.toMinor.toString(), r: r.rateMicro.toString(), fc: from.currency, tc: to.currency, exp });
    return {
      fromAccountId: from.id, toAccountId: to.id, fromCurrency: from.currency, toCurrency: to.currency, fromAmountMinor: i.amountMinor, toAmountMinor: num(r.toMinor),
      rate: Number(r.rateMicro) / 1e6, rateText: `1 ${foreign} = LKR ${(Number(r.rateMicro) / 1e6).toFixed(2)}`, token, expiresAt: new Date(exp).toISOString(),
      note: 'This is the exact amount you will get if you confirm before the quote expires.',
    };
  }

  // ───────────────────────── exchange ─────────────────────────
  private async clearing(tx: Prisma.TransactionClient, currency: string): Promise<string> {
    const code = `SYS-FX-CLEARING-${currency}`;
    return (await tx.ledgerAccount.upsert({ where: { code }, update: {}, create: { code, name: `Foreign exchange clearing (${currency})`, type: 'LIABILITY', currency, allowNegative: true } })).id;
  }

  /** Two single-currency journals in ONE database transaction: both post or neither does. The quote token makes a retry harmless. */
  async exchange(customerId: string, i: { token: string; pin: string }) {
    const q = this.verify(i.token, customerId);
    await this.pins.verify(customerId, i.pin);
    const { from, to } = await this.accounts(customerId, q.f, q.t);
    if (from.currency !== q.fc || to.currency !== q.tc) throw new UnprocessableEntityException({ code: 'invalid_quote', message: 'This quote is not valid. Please get a new one.' });
    const refBase = `FX-${createHash('sha256').update(i.token).digest('hex').slice(0, 20).toUpperCase()}`;
    const fromAmt = BigInt(q.a), toAmt = BigInt(q.o);

    const existing = await this.prisma.ledgerJournal.findUnique({ where: { reference: `${refBase}-OUT` } });
    if (existing) return { replayed: true, reference: refBase, fromAmountMinor: num(fromAmt), toAmountMinor: num(toAmt), fromCurrency: q.fc, toCurrency: q.tc };

    try {
      await this.prisma.$transaction(async (tx) => {
        const fromClearing = await this.clearing(tx, q.fc);
        const toClearing = await this.clearing(tx, q.tc);
        const desc = `Currency exchange ${q.fc} to ${q.tc}`;
        // Leg 1: the customer's source account is debited, clearing in that currency is credited.
        await this.ledger.post({ reference: `${refBase}-OUT`, kind: 'FX_EXCHANGE', currency: q.fc, description: desc, postings: [
          { ledgerAccountId: from.ledgerAccount!.id, direction: 'DEBIT', amountMinor: fromAmt, currency: q.fc },
          { ledgerAccountId: fromClearing, direction: 'CREDIT', amountMinor: fromAmt, currency: q.fc } ] }, tx);
        // Leg 2: clearing in the other currency is debited, the customer's destination account is credited.
        await this.ledger.post({ reference: `${refBase}-IN`, kind: 'FX_EXCHANGE', currency: q.tc, description: desc, postings: [
          { ledgerAccountId: toClearing, direction: 'DEBIT', amountMinor: toAmt, currency: q.tc },
          { ledgerAccountId: to.ledgerAccount!.id, direction: 'CREDIT', amountMinor: toAmt, currency: q.tc } ] }, tx);
        await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'fx.exchanged', subjectType: 'Account', subjectId: from.id, metadata: { reference: refBase, from: q.fc, to: q.tc, fromMinor: fromAmt.toString(), toMinor: toAmt.toString(), rateMicro: q.r } }, tx);
        await queueNotifications(tx, 'fx.exchanged', [{ userId: customerId, category: 'TRANSACTION', title: 'Currency exchanged', body: `You exchanged ${q.fc} ${(Number(fromAmt) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} for ${q.tc} ${(Number(toAmt) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}.` }]);
      }, { maxWait: 5000, timeout: 15000 });
    } catch (e) {
      if (e instanceof LedgerRejection) {
        if (e.code === 'INSUFFICIENT_FUNDS') throw new UnprocessableEntityException({ code: 'insufficient_funds', message: 'You do not have enough money in that account' });
        if (e.code === 'ACCOUNT_RESTRICTED') throw new UnprocessableEntityException({ code: 'account_restricted', message: 'An account involved cannot take part right now' });
        if (e.code === 'DUPLICATE_REFERENCE') return { replayed: true, reference: refBase, fromAmountMinor: num(fromAmt), toAmountMinor: num(toAmt), fromCurrency: q.fc, toCurrency: q.tc }; // a parallel retry won the race
      }
      if (e instanceof UnauthorizedException || e instanceof ConflictException) throw e;
      throw e;
    }
    return { replayed: false, reference: refBase, fromAmountMinor: num(fromAmt), toAmountMinor: num(toAmt), fromCurrency: q.fc, toCurrency: q.tc };
  }
}
