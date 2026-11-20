import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';
import { LedgerOpsService } from '../admin/ledger-ops.service';
import { OBJECT_STORAGE, safeFileName, sniffType, type ObjectStorage } from './storage';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ref = (p: string) => `${p}${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
const MAX_OPEN_TICKETS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TICKET = 10;
const DISPUTE_WINDOW_DAYS = 90;

export const DISPUTE_REASONS = ['UNAUTHORISED', 'WRONG_AMOUNT', 'DUPLICATE', 'NOT_RECEIVED', 'GOODS_NOT_RECEIVED', 'OTHER'] as const;
export const TICKET_CATEGORIES = ['GENERAL', 'ACCOUNT', 'CARD', 'PAYMENT', 'LOAN', 'TECHNICAL'] as const;
const DISPUTE_TEXT: Record<string, string> = { OPEN: 'Received', UNDER_REVIEW: 'Under review', ACCEPTED: 'Accepted', REJECTED: 'Not upheld' };
const TICKET_TEXT: Record<string, string> = { OPEN: 'Open', PENDING_CUSTOMER: 'Waiting for your reply', RESOLVED: 'Resolved', CLOSED: 'Closed' };

export const FAQS = [
  { q: 'How do I reset my password?', a: 'On the sign-in screen choose "Forgot password" and follow the steps. You will be signed out of all devices once it is changed.' },
  { q: 'What if a payment looks wrong?', a: 'Open the transaction and choose "Report a problem". The bank reviews every report and tells you the outcome. Reporting does not refund anything by itself.' },
  { q: 'How long does a new debit card take?', a: 'About 5 days after approval. You are notified when it is ready to collect, and you activate it in the app after collecting it.' },
  { q: 'Why was my transfer refused?', a: 'Common reasons are insufficient funds, a frozen account, or a transfer limit. The message on the receipt screen explains which.' },
  { q: 'Can the bank ask for my PIN?', a: 'Never. Zentrix staff will never ask for your PIN, password or authenticator code.' },
];

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledgerOps: LedgerOpsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ═════════════════════════ disputes ═════════════════════════
  private disputeView(d: { id: string; reference: string; paymentId: string; reasonCode: string; description: string; status: string; resolution: string | null; createdAt: Date; decidedAt: Date | null }, pay?: { reference: string; amountMinor: bigint; destination: unknown; postedAt: Date | null }) {
    const dest = pay?.destination as { name?: string } | undefined;
    return {
      id: d.id, reference: d.reference, paymentId: d.paymentId, reasonCode: d.reasonCode, description: d.description, status: d.status, statusText: DISPUTE_TEXT[d.status] ?? d.status,
      resolution: d.status === 'ACCEPTED' || d.status === 'REJECTED' ? d.resolution : null, createdAt: d.createdAt, decidedAt: d.decidedAt,
      payment: pay ? { reference: pay.reference, amountMinor: num(pay.amountMinor), recipient: dest?.name ?? null, postedAt: pay.postedAt } : null,
    };
  }

  /** Only a settled payment YOU made, within 90 days, one open report per payment. Reporting never moves money. */
  async createDispute(customerId: string, i: { paymentId: string; reasonCode: string; description: string }) {
    const p = await this.prisma.paymentInstruction.findUnique({ where: { id: i.paymentId } });
    if (!p || p.initiatorId !== customerId) {
      if (p) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'PaymentInstruction', id: i.paymentId });
      throw new NotFoundException({ code: 'not_found', message: 'Payment not found' });
    }
    if (p.status !== 'POSTED') throw new ConflictException({ code: 'not_disputable', message: 'Only a completed payment can be reported' });
    if (p.kind === 'OWN_TRANSFER') throw new ConflictException({ code: 'not_disputable', message: 'Moves between your own accounts cannot be disputed' });
    if (p.postedAt && Date.now() - p.postedAt.getTime() > DISPUTE_WINDOW_DAYS * 86_400_000) throw new ConflictException({ code: 'window_expired', message: `Payments can be reported within ${DISPUTE_WINDOW_DAYS} days` });
    if (await this.prisma.dispute.count({ where: { paymentId: i.paymentId, status: { in: ['OPEN', 'UNDER_REVIEW'] } } })) throw new ConflictException({ code: 'already_reported', message: 'You already reported this payment' });
    const d = await this.prisma.$transaction(async (tx) => {
      const row = await tx.dispute.create({ data: { reference: ref('DP'), customerId, paymentId: i.paymentId, reasonCode: i.reasonCode, description: i.description } });
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'dispute.created', subjectType: 'Dispute', subjectId: row.id, metadata: { reasonCode: i.reasonCode } }, tx);
      await queueNotifications(tx, 'dispute.created', [{ userId: customerId, category: 'TRANSACTION', title: 'Problem reported', body: `We received your report ${row.reference}. The bank will review it and update you.` }]);
      return row;
    });
    return this.disputeView(d, p);
  }

  async myDisputes(customerId: string) {
    const rows = await this.prisma.dispute.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const pays = new Map((await this.prisma.paymentInstruction.findMany({ where: { id: { in: rows.map((r) => r.paymentId) } } })).map((p) => [p.id, p]));
    return { items: rows.map((r) => this.disputeView(r, pays.get(r.paymentId))) };
  }

  async myDispute(customerId: string, id: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id } });
    if (!d || d.customerId !== customerId) {
      if (d) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'Dispute', id });
      throw new NotFoundException({ code: 'not_found', message: 'Report not found' });
    }
    return this.disputeView(d, (await this.prisma.paymentInstruction.findUnique({ where: { id: d.paymentId } })) ?? undefined);
  }

  async disputeQueue(status: string) {
    const s = ['OPEN', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED'].includes(status) ? status : 'OPEN';
    const rows = await this.prisma.dispute.findMany({ where: { status: s }, orderBy: { createdAt: 'asc' }, take: 100 });
    const pays = new Map((await this.prisma.paymentInstruction.findMany({ where: { id: { in: rows.map((r) => r.paymentId) } } })).map((p) => [p.id, p]));
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    return { items: rows.map((r) => ({ ...this.disputeView(r, pays.get(r.paymentId)), customerName: customers.get(r.customerId)?.fullName, customerNumber: customers.get(r.customerId)?.customerNumber, assignedToId: r.assignedToId, paymentKind: pays.get(r.paymentId)?.kind })) };
  }

  async startReview(staffId: string, id: string) {
    const r = await this.prisma.dispute.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'UNDER_REVIEW', assignedToId: staffId } });
    if (r.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This report is not waiting for review' });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'dispute.review_started', subjectType: 'Dispute', subjectId: id });
    return { id, status: 'UNDER_REVIEW' };
  }

  /**
   * Decision. ACCEPT can optionally open a reversal REQUEST (which still needs a second approver) so the dispute
   * outcome and the money movement stay two separate, separately-controlled decisions.
   */
  async decideDispute(staff: { id: string; permissions: ReadonlySet<string> }, id: string, d: { decision: 'ACCEPT' | 'REJECT'; resolution: string; requestReversal?: boolean }) {
    if (d.requestReversal && d.decision === 'ACCEPT' && !staff.permissions.has('transactions.adjust'))
      throw new UnprocessableEntityException({ code: 'forbidden_reversal', message: 'You cannot request reversals. Decide without it and ask an operations officer.' });
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException({ code: 'not_found', message: 'Report not found' });
    const out = await this.prisma.$transaction(async (tx) => {
      const c = await tx.dispute.updateMany({ where: { id, status: { in: ['OPEN', 'UNDER_REVIEW'] } }, data: { status: d.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', resolution: d.resolution, decidedById: staff.id, decidedAt: new Date() } });
      if (c.count !== 1) throw new ConflictException({ code: 'not_reviewable', message: 'This report was already decided' });
      await this.audit.record({ actorId: staff.id, actorType: 'STAFF', action: `dispute.${d.decision.toLowerCase()}ed`, subjectType: 'Dispute', subjectId: id, reasonCode: d.resolution.slice(0, 100) }, tx);
      await queueNotifications(tx, 'dispute.decided', [{ userId: dispute.customerId, category: 'TRANSACTION', title: d.decision === 'ACCEPT' ? 'Problem report accepted' : 'Problem report reviewed', body: `Report ${dispute.reference}: ${d.resolution}` }]);
      return { id, status: d.decision === 'ACCEPT' ? ('ACCEPTED' as const) : ('REJECTED' as const) };
    });
    let reversalApprovalId: string | null = null;
    if (d.requestReversal && d.decision === 'ACCEPT') {
      try { reversalApprovalId = (await this.ledgerOps.requestReversal(staff.id, dispute.paymentId, `Dispute ${dispute.reference}: ${d.resolution}`)).approvalId; } catch (e) { reversalApprovalId = null; if (!(e instanceof ConflictException)) throw e; }
    }
    return { ...out, reversalApprovalId };
  }

  // ═════════════════════════ tickets (customer) ═════════════════════════
  private ticketView(t: { id: string; reference: string; subject: string; category: string; status: string; createdAt: Date; updatedAt: Date }) {
    return { id: t.id, reference: t.reference, subject: t.subject, category: t.category, status: t.status, statusText: TICKET_TEXT[t.status] ?? t.status, createdAt: t.createdAt, updatedAt: t.updatedAt };
  }

  async createTicket(customerId: string, i: { subject: string; category: string; message: string }) {
    if ((await this.prisma.supportTicket.count({ where: { customerId, status: { in: ['OPEN', 'PENDING_CUSTOMER'] } } })) >= MAX_OPEN_TICKETS)
      throw new ConflictException({ code: 'too_many_tickets', message: `You already have ${MAX_OPEN_TICKETS} open requests. Please wait for a reply or close one.` });
    const t = await this.prisma.$transaction(async (tx) => {
      const row = await tx.supportTicket.create({ data: { reference: ref('ST'), customerId, subject: i.subject, category: i.category, messages: { create: { authorId: customerId, authorType: 'CUSTOMER', body: i.message } } } });
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'ticket.created', subjectType: 'SupportTicket', subjectId: row.id }, tx);
      return row;
    });
    return this.ticketView(t);
  }

  async myTickets(customerId: string) {
    const rows = await this.prisma.supportTicket.findMany({ where: { customerId }, orderBy: { updatedAt: 'desc' }, take: 50 });
    return { items: rows.map((t) => this.ticketView(t)) };
  }

  private async ownedTicket(customerId: string, id: string) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t || t.customerId !== customerId) {
      if (t) await this.audit.securityEvent('FORBIDDEN_RESOURCE_ACCESS', customerId, { resource: 'SupportTicket', id });
      throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
    }
    return t;
  }

  /** Customers never see internal staff notes. */
  async myTicket(customerId: string, id: string) {
    const t = await this.ownedTicket(customerId, id);
    const [messages, attachments] = await Promise.all([
      this.prisma.supportMessage.findMany({ where: { ticketId: id, internal: false }, orderBy: { createdAt: 'asc' } }),
      this.prisma.supportAttachment.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { ...this.ticketView(t), messages: messages.map((m) => ({ id: m.id, from: m.authorType, body: m.body, at: m.createdAt })), attachments: attachments.map((a) => ({ id: a.id, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, at: a.createdAt })) };
  }

  async customerReply(customerId: string, id: string, body: string) {
    const t = await this.ownedTicket(customerId, id);
    if (t.status === 'CLOSED') throw new ConflictException({ code: 'ticket_closed', message: 'This request is closed. Please open a new one.' });
    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({ data: { ticketId: id, authorId: customerId, authorType: 'CUSTOMER', body } });
      await tx.supportTicket.update({ where: { id }, data: { status: 'OPEN', closedAt: null } }); // a reply reopens a resolved request
    });
    return this.myTicket(customerId, id);
  }

  async customerClose(customerId: string, id: string) {
    await this.ownedTicket(customerId, id);
    await this.prisma.supportTicket.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'ticket.closed', subjectType: 'SupportTicket', subjectId: id });
  }

  // ═════════════════════════ attachments ═════════════════════════
  async addAttachment(actor: { id: string; type: 'CUSTOMER' | 'STAFF' }, ticketId: string, file: { buffer: Buffer; originalname: string }) {
    const t = actor.type === 'CUSTOMER' ? await this.ownedTicket(actor.id, ticketId) : await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
    if (t.status === 'CLOSED') throw new ConflictException({ code: 'ticket_closed', message: 'This request is closed' });
    if (file.buffer.length === 0) throw new BadRequestException({ code: 'empty_file', message: 'The file is empty' });
    if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw new PayloadTooLargeException({ code: 'file_too_large', message: 'Files can be at most 5 MB' });
    const kind = sniffType(file.buffer); // judged by the bytes, never by the declared type or extension
    if (!kind) throw new UnprocessableEntityException({ code: 'unsupported_type', message: 'Only PNG, JPEG and PDF files are accepted' });
    if ((await this.prisma.supportAttachment.count({ where: { ticketId } })) >= MAX_ATTACHMENTS_PER_TICKET) throw new ConflictException({ code: 'too_many_files', message: 'This request already has the maximum number of files' });
    const stored = await this.storage.put(file.buffer);
    try {
      const row = await this.prisma.supportAttachment.create({ data: { ticketId, uploadedById: actor.id, fileName: safeFileName(file.originalname, kind.ext), contentType: kind.contentType, sizeBytes: file.buffer.length, sha256: stored.sha256, storageKey: stored.key } });
      await this.audit.record({ actorId: actor.id, actorType: actor.type, action: 'ticket.attachment_added', subjectType: 'SupportTicket', subjectId: ticketId, metadata: { sizeBytes: row.sizeBytes } });
      return { id: row.id, fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes };
    } catch (e) {
      await this.storage.remove(stored.key); // never leave an orphaned file
      throw e;
    }
  }

  async downloadAttachment(actor: { id: string; type: 'CUSTOMER' | 'STAFF' }, ticketId: string, attachmentId: string) {
    if (actor.type === 'CUSTOMER') await this.ownedTicket(actor.id, ticketId);
    const a = await this.prisma.supportAttachment.findFirst({ where: { id: attachmentId, ticketId } });
    if (!a) throw new NotFoundException({ code: 'not_found', message: 'File not found' });
    return { buffer: await this.storage.get(a.storageKey), fileName: a.fileName, contentType: a.contentType };
  }

  // ═════════════════════════ tickets (staff) ═════════════════════════
  async ticketQueue(status: string, mineFor?: string) {
    const s = ['OPEN', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'].includes(status) ? status : 'OPEN';
    const rows = await this.prisma.supportTicket.findMany({ where: { status: s, ...(mineFor ? { assignedToId: mineFor } : {}) }, orderBy: { updatedAt: 'asc' }, take: 100 });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    return { items: rows.map((t) => ({ ...this.ticketView(t), assignedToId: t.assignedToId, priority: t.priority, customerName: customers.get(t.customerId)?.fullName, customerNumber: customers.get(t.customerId)?.customerNumber })) };
  }

  async staffTicket(id: string) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
    const [messages, attachments, customer] = await Promise.all([
      this.prisma.supportMessage.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.supportAttachment.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.customerProfile.findUnique({ where: { userId: t.customerId } }),
    ]);
    const authors = new Map((await this.prisma.staffProfile.findMany({ where: { userId: { in: messages.filter((m) => m.authorType === 'STAFF').map((m) => m.authorId) } } })).map((s) => [s.userId, s.fullName]));
    return {
      ...this.ticketView(t), assignedToId: t.assignedToId, customer: { id: t.customerId, name: customer?.fullName, customerNumber: customer?.customerNumber },
      messages: messages.map((m) => ({ id: m.id, from: m.authorType, authorName: m.authorType === 'STAFF' ? authors.get(m.authorId) : customer?.fullName, body: m.body, internal: m.internal, at: m.createdAt })),
      attachments: attachments.map((a) => ({ id: a.id, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, at: a.createdAt })),
    };
  }

  async staffReply(staffId: string, id: string, i: { body: string; internal?: boolean }) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
    if (t.status === 'CLOSED') throw new ConflictException({ code: 'ticket_closed', message: 'This request is closed' });
    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({ data: { ticketId: id, authorId: staffId, authorType: 'STAFF', body: i.body, internal: !!i.internal } });
      if (!i.internal) {
        await tx.supportTicket.update({ where: { id }, data: { status: 'PENDING_CUSTOMER', assignedToId: t.assignedToId ?? staffId } });
        await queueNotifications(tx, 'ticket.replied', [{ userId: t.customerId, category: 'ACCOUNT', title: 'Reply to your request', body: `The bank replied to ${t.reference}: ${i.body.slice(0, 120)}` }]);
      }
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: i.internal ? 'ticket.note_added' : 'ticket.replied', subjectType: 'SupportTicket', subjectId: id }, tx);
    });
    return this.staffTicket(id);
  }

  async assignToMe(staffId: string, id: string) {
    const r = await this.prisma.supportTicket.updateMany({ where: { id, status: { not: 'CLOSED' } }, data: { assignedToId: staffId } });
    if (r.count !== 1) throw new ConflictException({ code: 'invalid_state', message: 'This request cannot be assigned' });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'ticket.assigned', subjectType: 'SupportTicket', subjectId: id });
    return { id, assignedToId: staffId };
  }

  async setStatus(staffId: string, id: string, status: 'OPEN' | 'RESOLVED' | 'CLOSED') {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'Request not found' });
    if (t.status === 'CLOSED') throw new ConflictException({ code: 'ticket_closed', message: 'This request is closed' });
    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicket.update({ where: { id }, data: { status, closedAt: status === 'CLOSED' ? new Date() : null } });
      if (status !== 'OPEN') await queueNotifications(tx, 'ticket.status', [{ userId: t.customerId, category: 'ACCOUNT', title: status === 'RESOLVED' ? 'Request resolved' : 'Request closed', body: `Your request ${t.reference} was marked ${status.toLowerCase()}. Reply if you still need help.` }]);
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: `ticket.${status.toLowerCase()}`, subjectType: 'SupportTicket', subjectId: id }, tx);
    });
    return { id, status };
  }

  // ═════════════════════════ branches & appointments ═════════════════════════
  async branches(q: { city?: string; type?: string; lat?: number; lng?: number }) {
    const rows = await this.prisma.branch.findMany({ where: { active: true, ...(q.city ? { city: { equals: q.city, mode: 'insensitive' } } : {}), ...(q.type === 'ATM' || q.type === 'BRANCH' ? { type: q.type } : {}) }, orderBy: [{ city: 'asc' }, { name: 'asc' }] });
    const km = (b: { latitude: number | null; longitude: number | null }) => {
      if (q.lat === undefined || q.lng === undefined || b.latitude === null || b.longitude === null) return null;
      const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
      const dLat = rad(b.latitude - q.lat), dLng = rad(b.longitude - q.lng);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(q.lat)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
      return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
    };
    const items = rows.map((b) => ({ id: b.id, code: b.code, name: b.name, city: b.city, address: b.address, type: b.type, phone: b.phone, hours: b.hours, latitude: b.latitude, longitude: b.longitude, distanceKm: km(b) }));
    if (q.lat !== undefined && q.lng !== undefined) items.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    return { items };
  }

  async requestAppointment(customerId: string, i: { branchId: string; purpose: string; preferredAt: string }) {
    const at = new Date(i.preferredAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 3_600_000 || at.getTime() > Date.now() + 60 * 86_400_000) throw new BadRequestException({ code: 'validation_failed', message: 'Choose a time between one hour and 60 days from now', fields: { preferredAt: 'Invalid time' } });
    const branch = await this.prisma.branch.findFirst({ where: { id: i.branchId, active: true, type: 'BRANCH' } });
    if (!branch) throw new NotFoundException({ code: 'not_found', message: 'Branch not found' });
    if ((await this.prisma.appointment.count({ where: { customerId, status: { in: ['REQUESTED', 'CONFIRMED'] } } })) >= 3) throw new ConflictException({ code: 'too_many_appointments', message: 'You already have 3 upcoming appointments' });
    const a = await this.prisma.appointment.create({ data: { customerId, branchId: i.branchId, purpose: i.purpose, preferredAt: at } });
    await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'appointment.requested', subjectType: 'Appointment', subjectId: a.id });
    return { id: a.id, status: a.status };
  }

  async myAppointments(customerId: string) {
    const rows = await this.prisma.appointment.findMany({ where: { customerId }, orderBy: { preferredAt: 'desc' }, take: 50 });
    const branches = new Map((await this.prisma.branch.findMany({ where: { id: { in: rows.map((r) => r.branchId) } } })).map((b) => [b.id, b]));
    return { items: rows.map((a) => ({ id: a.id, branch: branches.get(a.branchId)?.name, city: branches.get(a.branchId)?.city, purpose: a.purpose, preferredAt: a.preferredAt, status: a.status, confirmedFor: a.confirmedFor, note: a.status === 'CANCELLED' ? a.note : null })) };
  }

  async cancelAppointment(customerId: string, id: string) {
    const r = await this.prisma.appointment.updateMany({ where: { id, customerId, status: { in: ['REQUESTED', 'CONFIRMED'] } }, data: { status: 'CANCELLED', note: 'Cancelled by customer' } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Appointment not found or already finished' });
  }

  async appointmentQueue(status: string) {
    const s = ['REQUESTED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'].includes(status) ? status : 'REQUESTED';
    const rows = await this.prisma.appointment.findMany({ where: { status: s }, orderBy: { preferredAt: 'asc' }, take: 100 });
    const branches = new Map((await this.prisma.branch.findMany({ where: { id: { in: rows.map((r) => r.branchId) } } })).map((b) => [b.id, b]));
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    return { items: rows.map((a) => ({ id: a.id, status: a.status, purpose: a.purpose, preferredAt: a.preferredAt, confirmedFor: a.confirmedFor, branch: branches.get(a.branchId)?.name, customerName: customers.get(a.customerId)?.fullName, customerNumber: customers.get(a.customerId)?.customerNumber })) };
  }

  async decideAppointment(staffId: string, id: string, d: { decision: 'CONFIRM' | 'CANCEL' | 'COMPLETE'; confirmedFor?: string; note?: string }) {
    if (d.decision === 'CONFIRM' && (!d.confirmedFor || Number.isNaN(Date.parse(d.confirmedFor)) || Date.parse(d.confirmedFor) < Date.now())) throw new BadRequestException({ code: 'validation_failed', message: 'Choose a future time to confirm', fields: { confirmedFor: 'Required' } });
    if (d.decision === 'CANCEL' && !d.note) throw new BadRequestException({ code: 'reason_required', message: 'A reason is required', fields: { note: 'Required' } });
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.appointment.findUnique({ where: { id } });
      if (!a) throw new NotFoundException({ code: 'not_found', message: 'Appointment not found' });
      const from = d.decision === 'COMPLETE' ? ['CONFIRMED'] : ['REQUESTED', 'CONFIRMED'];
      const to = d.decision === 'CONFIRM' ? 'CONFIRMED' : d.decision === 'CANCEL' ? 'CANCELLED' : 'COMPLETED';
      const r = await tx.appointment.updateMany({ where: { id, status: { in: from } }, data: { status: to, decidedById: staffId, confirmedAt: d.decision === 'CONFIRM' ? new Date() : undefined, confirmedFor: d.decision === 'CONFIRM' ? new Date(d.confirmedFor!) : undefined, note: d.note } });
      if (r.count !== 1) throw new ConflictException({ code: 'invalid_state', message: 'This appointment cannot be changed that way' });
      const b = await tx.branch.findUnique({ where: { id: a.branchId } });
      if (d.decision !== 'COMPLETE') await queueNotifications(tx, 'appointment.decided', [{ userId: a.customerId, category: 'ACCOUNT', title: d.decision === 'CONFIRM' ? 'Appointment confirmed' : 'Appointment cancelled', body: d.decision === 'CONFIRM' ? `${b?.name}: ${new Date(d.confirmedFor!).toISOString().slice(0, 16).replace('T', ' ')} (UTC)` : `Your appointment at ${b?.name} was cancelled: ${d.note}` }]);
      await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: `appointment.${to.toLowerCase()}`, subjectType: 'Appointment', subjectId: id }, tx);
      return { id, status: to };
    });
  }

  // staff branch management
  async createBranch(staffId: string, b: { code: string; name: string; city: string; address: string; type: 'BRANCH' | 'ATM'; phone?: string; hours?: string; latitude?: number; longitude?: number }) {
    if (await this.prisma.branch.findUnique({ where: { code: b.code } })) throw new ConflictException({ code: 'duplicate', message: 'That branch code is already in use' });
    const row = await this.prisma.branch.create({ data: b });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'branch.created', subjectType: 'Branch', subjectId: row.id });
    return { id: row.id };
  }

  async updateBranch(staffId: string, id: string, b: Partial<{ name: string; city: string; address: string; phone: string; hours: string; latitude: number; longitude: number; active: boolean }>) {
    const r = await this.prisma.branch.updateMany({ where: { id }, data: b });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Branch not found' });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: b.active === false ? 'branch.deactivated' : 'branch.updated', subjectType: 'Branch', subjectId: id });
    return { id };
  }

  async adminBranches() {
    const rows = await this.prisma.branch.findMany({ orderBy: [{ city: 'asc' }, { name: 'asc' }] });
    return { items: rows.map((b) => ({ id: b.id, code: b.code, name: b.name, city: b.city, address: b.address, type: b.type, phone: b.phone, hours: b.hours, active: b.active, latitude: b.latitude, longitude: b.longitude })) };
  }
}
