import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { toCsv } from '../../common/csv';
import { PrismaService } from '../../common/prisma.service';
import { masked, num } from '../accounts/accounts.service';
import { formatMinor } from '../ledger/money';
import { PaymentsService } from '../payments/payments.service';
import { paymentCategory } from '../savings/savings.service';
import { simpleInterest } from '../deposits/interest';
import { dateText, Doc, label, lkrText, moneyText, type Lang } from './pdf';

const OFFSET_MS = 5.5 * 3_600_000; // Sri Lanka
const MAX_ROWS = 5000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** "2026-03-15" as midnight Sri Lanka time, in UTC. */
export function colomboStart(day: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new BadRequestException({ code: 'validation_failed', message: 'Dates must look like 2026-03-31' });
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - OFFSET_MS);
  if (Number.isNaN(d.getTime()) || dateText(new Date(d.getTime() + OFFSET_MS)) !== day) throw new BadRequestException({ code: 'validation_failed', message: 'That is not a real date' });
  return d;
}

export interface SearchQuery { accountId?: string; category?: string; q?: string; from?: string; to?: string; minMinor?: number; maxMinor?: number; direction?: 'IN' | 'OUT'; kind?: string; limit?: number; cursor?: string }

/** Spending category as a database filter, mirroring paymentCategory(): bills by their category, then Transfers and Loan repayments. */
function categoryFilter(category: string): Prisma.PaymentInstructionWhereInput {
  const byKind: Prisma.PaymentInstructionWhereInput =
    category === 'Transfers' ? { kind: { in: ['INTERNAL_TRANSFER', 'INTERBANK_TRANSFER', 'QR_PAYMENT'] } }
    : category === 'Loan repayments' ? { kind: 'LOAN_INSTALMENT' }
    : { kind: 'BILL_PAYMENT', destination: { path: ['category'], equals: category } };
  return { OR: [{ category }, { AND: [{ category: null }, byKind] }] }; // the customer's own label wins over the default
}

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly payments: PaymentsService) {}

  private async ownedAccount(customerId: string, id: string) {
    const a = await this.prisma.account.findUnique({ where: { id }, include: { product: true, ledgerAccount: true, customer: true } });
    if (!a || a.customerId !== customerId) {
      if (a) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Account', id });
      throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    }
    return a;
  }

  // ═════════════════════════ transaction search ═════════════════════════
  async search(customerId: string, q: SearchQuery) {
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const accounts = await this.prisma.account.findMany({ where: { customerId, ...(q.accountId ? { id: q.accountId } : {}), status: { not: 'CLOSED' } }, include: { ledgerAccount: true } });
    if (q.accountId && accounts.length === 0) {
      const a = await this.prisma.account.findUnique({ where: { id: q.accountId } });
      if (a && a.customerId !== customerId) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Account', id: q.accountId });
      throw new NotFoundException({ code: 'not_found', message: 'Account not found' });
    }
    const byLedger = new Map(accounts.filter((a) => a.ledgerAccount).map((a) => [a.ledgerAccount!.id, a]));
    const where: Prisma.LedgerPostingWhereInput = { ledgerAccountId: { in: [...byLedger.keys()] } };
    if (q.direction) where.direction = q.direction === 'IN' ? 'CREDIT' : 'DEBIT';
    if (q.minMinor !== undefined || q.maxMinor !== undefined) where.amountMinor = { ...(q.minMinor !== undefined ? { gte: BigInt(q.minMinor) } : {}), ...(q.maxMinor !== undefined ? { lte: BigInt(q.maxMinor) } : {}) };
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: colomboStart(q.from) } : {}), ...(q.to ? { lt: new Date(colomboStart(q.to).getTime() + 86_400_000) } : {}) };
    const term = q.q?.trim();
    const journal: Prisma.LedgerJournalWhereInput = { ...(q.kind ? { kind: q.kind } : {}), ...(q.category ? { payment: categoryFilter(q.category) } : {}), ...(term && term.length >= 2 ? { OR: [{ description: { contains: term, mode: 'insensitive' } }, { reference: { contains: term, mode: 'insensitive' } }] } : {}) };
    if (Object.keys(journal).length) where.journal = journal;
    if (q.cursor) {
      const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (!at || !id || Number.isNaN(Date.parse(at))) throw new BadRequestException({ code: 'validation_failed', message: 'Invalid cursor' });
      where.AND = [{ OR: [{ createdAt: { lt: new Date(at) } }, { createdAt: new Date(at), id: { lt: id } }] }];
    }
    const rows = await this.prisma.ledgerPosting.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: { journal: true } });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((p) => ({
        id: p.id, accountId: byLedger.get(p.ledgerAccountId)?.id, accountLabel: byLedger.get(p.ledgerAccountId)?.nickname ?? masked(byLedger.get(p.ledgerAccountId)?.accountNumber ?? ''),
        reference: p.journal.reference, kind: p.journal.kind, description: p.journal.description, amountMinor: num(p.direction === 'CREDIT' ? p.amountMinor : -p.amountMinor), currency: p.currency, status: p.journal.status, postedAt: p.createdAt, paymentId: p.journal.paymentId,
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  /** One transaction in full, for the details screen: the posting, its payment (if any) and what can be done next. */
  async detail(customerId: string, postingId: string) {
    const p = await this.prisma.ledgerPosting.findUnique({ where: { id: postingId }, include: { journal: { include: { payment: true } }, ledgerAccount: { include: { account: true } } } });
    const acc = p?.ledgerAccount.account;
    if (!p || !acc || acc.customerId !== customerId) {
      if (p && acc) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'LedgerPosting', id: postingId });
      throw new NotFoundException({ code: 'not_found', message: 'Transaction not found' });
    }
    const pay = p.journal.payment;
    const mine = !!pay && pay.initiatorId === customerId;
    const dest = (pay?.destination ?? {}) as Record<string, unknown>;
    const reversed = !!(await this.prisma.ledgerJournal.findFirst({ where: { reversesJournalId: p.journal.id }, select: { id: true } }));
    return {
      id: p.id, reference: p.journal.reference, kind: p.journal.kind, description: p.journal.description, status: reversed ? 'REVERSED' : p.journal.status,
      amountMinor: num(p.direction === 'CREDIT' ? p.amountMinor : -p.amountMinor), currency: p.currency, postedAt: p.createdAt,
      account: { id: acc.id, label: acc.nickname ?? masked(acc.accountNumber), numberMasked: masked(acc.accountNumber) },
      category: pay && mine ? paymentCategory(pay.kind, pay.destination, pay.category) : null,
      counterparty: mine ? { name: (dest.name as string | undefined) ?? null, bank: (dest.bank as string | undefined) ?? null, accountMasked: (dest.accountMasked as string | undefined) ?? null } : null,
      note: mine ? pay!.note : null, feeMinor: mine ? num(pay!.feeMinor) : 0,
      paymentId: pay ? pay.id : null,
      canRepeat: mine && pay!.status === 'POSTED' && pay!.kind !== 'LOAN_INSTALMENT' && !reversed, // only payments made in the app, and never a loan instalment
      canReport: mine && pay!.status === 'POSTED' && pay!.kind !== 'OWN_TRANSFER',
    };
  }

  /** A new payment draft body copied from an earlier payment of this customer's, so "repeat" never invents a recipient. */
  async repeatDraft(customerId: string, paymentId: string) {
    const pay = await this.prisma.paymentInstruction.findUnique({ where: { id: paymentId } });
    if (!pay || pay.initiatorId !== customerId) {
      if (pay) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'PaymentInstruction', id: paymentId });
      throw new NotFoundException({ code: 'not_found', message: 'Payment not found' });
    }
    if (pay.status !== 'POSTED' || pay.kind === 'LOAN_INSTALMENT') throw new ConflictException({ code: 'not_repeatable', message: 'This payment cannot be repeated' });
    const d = (pay.destination ?? {}) as Record<string, unknown>;
    let destination: Record<string, unknown> | null = null;
    if (d.settle === 'INTERNAL' && typeof d.toAccountId === 'string') {
      const to = await this.prisma.account.findUnique({ where: { id: d.toAccountId } });
      if (!to || to.status === 'CLOSED') throw new ConflictException({ code: 'recipient_unavailable', message: 'That account is no longer available' });
      destination = to.customerId === customerId ? { type: 'OWN', accountId: to.id } : { type: 'ZENTRIX', accountNumber: to.accountNumber };
    } else if (d.settle === 'INTERBANK') destination = { type: 'INTERBANK', bankCode: d.bankCode, accountNumber: d.accountNumber, holderName: d.name };
    else if (d.settle === 'BILL') destination = { type: 'BILL', billerCode: d.billerCode, billRef: d.billRef };
    if (!destination) throw new ConflictException({ code: 'not_repeatable', message: 'This payment cannot be repeated' });
    return { sourceAccountId: pay.sourceAccountId, destination, amountMinor: num(pay.amountMinor), note: pay.note, recipientName: (d.name as string | undefined) ?? null };
  }

  // ═════════════════════════ statements ═════════════════════════
  async statement(customerId: string, accountId: string, o: { from?: string; to?: string; format: 'pdf' | 'csv'; lang: Lang }) {
    const acc = await this.ownedAccount(customerId, accountId);
    if (!acc.ledgerAccount) throw new ConflictException({ code: 'no_ledger', message: 'This account has no ledger yet' });
    const today = dateText(new Date(Date.now() + OFFSET_MS));
    const toDay = o.to ?? today;
    const fromDay = o.from ?? dateText(new Date(Date.parse(toDay) - 29 * 86_400_000));
    const start = colomboStart(fromDay);
    const endExcl = new Date(colomboStart(toDay).getTime() + 86_400_000);
    if (endExcl <= start) throw new BadRequestException({ code: 'validation_failed', message: 'The end date must not be before the start date' });
    if (endExcl.getTime() - start.getTime() > 367 * 86_400_000) throw new BadRequestException({ code: 'range_too_large', message: 'A statement covers at most one year' });

    const la = acc.ledgerAccount.id;
    const opening = (await this.prisma.$queryRaw<{ v: bigint }[]>(Prisma.sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::bigint AS v FROM "LedgerPosting" WHERE "ledgerAccountId" = ${la}::uuid AND "createdAt" < ${start}`))[0]!.v;
    const rows = await this.prisma.ledgerPosting.findMany({ where: { ledgerAccountId: la, createdAt: { gte: start, lt: endExcl } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: MAX_ROWS + 1, include: { journal: true } });
    if (rows.length > MAX_ROWS) throw new UnprocessableEntityException({ code: 'too_many_rows', message: `That period has more than ${MAX_ROWS} entries. Please choose a shorter period.` });

    const cur = acc.currency;
    const money = (v: bigint | number) => moneyText(v, cur);
    let run = opening;
    const lines = rows.map((p) => {
      const signed = p.direction === 'CREDIT' ? p.amountMinor : -p.amountMinor;
      run += signed;
      return { date: dateText(new Date(p.createdAt.getTime() + OFFSET_MS)), reference: p.journal.reference, description: p.journal.description ?? p.journal.kind, debit: p.direction === 'DEBIT' ? p.amountMinor : 0n, credit: p.direction === 'CREDIT' ? p.amountMinor : 0n, balance: run };
    });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'document.statement', subjectType: 'Account', subjectId: accountId, metadata: { format: o.format, rows: lines.length } });
    const base = `statement-${acc.accountNumber.slice(-4)}-${fromDay}_${toDay}`;

    if (o.format === 'csv') {
      const csv = toCsv(['date', 'reference', 'description', 'debit', 'credit', 'balance'], [
        { date: fromDay, reference: '', description: 'Opening balance', debit: '', credit: '', balance: formatMinor(opening) },
        ...lines.map((l) => ({ date: l.date, reference: l.reference, description: l.description, debit: l.debit ? formatMinor(l.debit) : '', credit: l.credit ? formatMinor(l.credit) : '', balance: formatMinor(l.balance) })),
      ]);
      return { buffer: Buffer.from(`﻿${csv}`, 'utf8'), filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8' }; // BOM so spreadsheets read Sinhala/Tamil correctly
    }

    const cols: [number, number, 'left' | 'right'][] = [[48, 62, 'left'], [114, 92, 'left'], [210, 140, 'left'], [354, 62, 'right'], [420, 62, 'right'], [486, 62, 'right']];
    const head = (d: Doc) => d.row(cols, [label(d.lang, 'date'), label(d.lang, 'reference'), label(d.lang, 'description'), label(d.lang, 'debit'), label(d.lang, 'credit'), label(d.lang, 'balance')], { bold: true, size: 8 });
    const doc = new Doc(o.lang, label(o.lang, 'statement'), (d) => head(d));
    doc.header(label(o.lang, 'statement'));
    doc.line(`${label(o.lang, 'holder')}: ${acc.customer.fullName}`);
    doc.line(`${label(o.lang, 'account')}: ${acc.accountNumber} · ${acc.product.name}${acc.nickname ? ` · ${acc.nickname}` : ''}`);
    doc.line(`${label(o.lang, 'period')}: ${fromDay} – ${toDay}`, { gap: 8 });
    doc.line(`${label(o.lang, 'opening')}: ${money(opening)}`, { bold: true, gap: 8 });
    doc.rule();
    head(doc);
    if (lines.length === 0) doc.line(label(o.lang, 'noTransactions'));
    for (const l of lines) doc.row(cols, [l.date, l.reference, l.description, l.debit ? money(l.debit).replace(`${cur} `, '') : '', l.credit ? money(l.credit).replace(`${cur} `, '') : '', money(l.balance).replace(`${cur} `, '')], { size: 8 });
    doc.rule();
    doc.line(`${label(o.lang, 'closing')}: ${money(run)}`, { bold: true });
    return { buffer: await doc.finish(), filename: `${base}.pdf`, contentType: 'application/pdf' };
  }

  // ═════════════════════════ receipt ═════════════════════════
  async receipt(customerId: string, paymentId: string, lang: Lang) {
    const p = await this.payments.get(customerId, paymentId); // ownership enforced there
    if (p.status !== 'POSTED' && p.status !== 'REVERSED') throw new ConflictException({ code: 'no_receipt', message: 'A receipt is available once a payment is completed' });
    const src = await this.prisma.account.findUnique({ where: { id: p.sourceAccountId } });
    const doc = new Doc(lang, label(lang, 'receipt'));
    doc.header(label(lang, 'receipt'));
    const kv = (k: string, v: string, bold = false) => { doc.text(`${label(lang, k)}`, doc.left, doc.y, { size: 9, color: '#54627f', width: 130 }); const h = doc.text(v, doc.left + 140, doc.y, { bold, size: 10, width: doc.right - doc.left - 140 }); doc.y += Math.max(h, 12) + 6; };
    kv('reference', p.reference, true);
    kv('status', p.status === 'POSTED' ? 'POSTED' : 'REVERSED');
    kv('amount', lkrText(p.amountMinor));
    if (p.feeMinor > 0) kv('fee', lkrText(p.feeMinor));
    kv('total', lkrText(p.totalMinor), true);
    kv('to', `${p.recipient.name} · ${p.recipient.bank} · ${p.recipient.accountMasked}`);
    if (src) kv('from', `${src.nickname ?? ''} ${masked(src.accountNumber)}`.trim());
    if (p.note) kv('note', p.note);
    if (p.postedAt) kv('paidAt', p.postedAt.replace('T', ' ').slice(0, 19) + ' UTC');
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'document.receipt', subjectType: 'PaymentInstruction', subjectId: paymentId });
    return { buffer: await doc.finish(), filename: `receipt-${p.reference}.pdf`, contentType: 'application/pdf' };
  }

  // ═════════════════════════ certificates ═════════════════════════
  async accountCertificate(customerId: string, accountId: string, lang: Lang) {
    const a = await this.ownedAccount(customerId, accountId);
    const doc = new Doc(lang, label(lang, 'certificate'));
    doc.header(label(lang, 'certificate'));
    doc.line(label(lang, 'certifies'), { gap: 10 });
    const asOf = new Date();
    const ref = `ZC${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
    const kv = (k: string, v: string) => { doc.text(label(lang, k), doc.left, doc.y, { size: 9, color: '#54627f', width: 130 }); const h = doc.text(v, doc.left + 140, doc.y, { width: doc.right - doc.left - 140 }); doc.y += Math.max(h, 12) + 6; };
    kv('holder', a.customer.fullName);
    kv('account', a.accountNumber);
    kv('product', a.product.name);
    kv('opened', dateText(a.openedAt));
    kv('status', a.status);
    kv('balance', moneyText(a.ledgerAccount?.balanceMinor ?? 0n, a.currency));
    kv('asOf', dateText(asOf));
    kv('certRef', ref);
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'document.account_certificate', subjectType: 'Account', subjectId: accountId, metadata: { certificate: ref } });
    return { buffer: await doc.finish(), filename: `certificate-${a.accountNumber.slice(-4)}.pdf`, contentType: 'application/pdf' };
  }

  async depositCertificate(customerId: string, id: string, lang: Lang) {
    const fd = await this.prisma.fixedDeposit.findUnique({ where: { id } });
    if (!fd || fd.customerId !== customerId) {
      if (fd) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'FixedDeposit', id });
      throw new NotFoundException({ code: 'not_found', message: 'Fixed deposit not found' });
    }
    const holder = await this.prisma.customerProfile.findUniqueOrThrow({ where: { userId: customerId } });
    const doc = new Doc(lang, label(lang, 'fdCertificate'));
    doc.header(label(lang, 'fdCertificate'));
    const kv = (k: string, v: string) => { doc.text(label(lang, k), doc.left, doc.y, { size: 9, color: '#54627f', width: 130 }); const h = doc.text(v, doc.left + 140, doc.y, { width: doc.right - doc.left - 140 }); doc.y += Math.max(h, 12) + 6; };
    kv('holder', holder.fullName);
    kv('reference', fd.reference);
    kv('principal', lkrText(fd.principalMinor));
    kv('rate', `${(fd.rateBps / 100).toFixed(2)}%`);
    kv('term', `${fd.termMonths}`);
    kv('opened', dateText(fd.startDate));
    kv('matures', dateText(fd.maturityDate));
    kv('interest', lkrText(simpleInterest(fd.principalMinor, fd.rateBps, fd.termMonths)));
    kv('status', fd.status);
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'document.fd_certificate', subjectType: 'FixedDeposit', subjectId: id });
    return { buffer: await doc.finish(), filename: `fd-certificate-${fd.reference}.pdf`, contentType: 'application/pdf' };
  }

  async loanSchedule(customerId: string, id: string, lang: Lang) {
    const loan = await this.prisma.loan.findUnique({ where: { id }, include: { schedule: { orderBy: { instalmentNo: 'asc' } } } });
    if (!loan || loan.customerId !== customerId) {
      if (loan) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Loan', id });
      throw new NotFoundException({ code: 'not_found', message: 'Loan not found' });
    }
    const holder = await this.prisma.customerProfile.findUniqueOrThrow({ where: { userId: customerId } });
    const outstanding = (await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: loan.ledgerAccountId } })).balanceMinor;
    const cols: [number, number, 'left' | 'right'][] = [[48, 30, 'left'], [82, 70, 'left'], [156, 90, 'right'], [250, 90, 'right'], [344, 90, 'right'], [438, 90, 'left']];
    const head = (d: Doc) => d.row(cols, [label(d.lang, 'instalment'), label(d.lang, 'due'), label(d.lang, 'credit').length ? label(d.lang, 'balance') : '', label(d.lang, 'interest'), label(d.lang, 'paid'), label(d.lang, 'status')], { bold: true, size: 8 });
    const doc = new Doc(lang, label(lang, 'schedule'), (d) => head(d));
    doc.header(label(lang, 'schedule'));
    doc.line(`${label(lang, 'holder')}: ${holder.fullName}`);
    doc.line(`${label(lang, 'reference')}: ${loan.reference} · ${(loan.rateBps / 100).toFixed(2)}% · ${loan.termMonths}`);
    doc.line(`${label(lang, 'outstanding')}: ${lkrText(outstanding)}`, { bold: true, gap: 8 });
    doc.rule();
    head(doc);
    for (const r of loan.schedule) doc.row(cols, [String(r.instalmentNo), dateText(r.dueDate), lkrText(r.principalMinor).replace('LKR ', ''), lkrText(r.interestMinor).replace('LKR ', ''), lkrText(r.paidPrincipalMinor + r.paidInterestMinor).replace('LKR ', ''), r.status], { size: 8 });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'document.loan_schedule', subjectType: 'Loan', subjectId: id });
    return { buffer: await doc.finish(), filename: `loan-schedule-${loan.reference}.pdf`, contentType: 'application/pdf' };
  }
}
