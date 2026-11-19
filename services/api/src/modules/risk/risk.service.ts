import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { lkr, queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { num } from '../accounts/accounts.service';

const MIN = 60_000;
const DAY = 86_400_000;

export const RISK_DEFAULTS = { highValueMinor: 50_000_000, velocityCount: 5, newPayeeMinor: 20_000_000, newDeviceMinor: 10_000_000, anomalyEnabled: false };
export type RiskConfig = typeof RISK_DEFAULTS;
export type RuleCode = 'HIGH_VALUE' | 'VELOCITY' | 'NEW_PAYEE_LARGE' | 'NEW_DEVICE_ACTIVITY' | 'ANOMALY_EXPERIMENT';

export interface Hit { ruleCode: RuleCode; severity: 'LOW' | 'MEDIUM' | 'HIGH'; summary: string; details: Record<string, unknown> }
export interface PaymentFacts { id: string; initiatorId: string; amountMinor: bigint; postedAt: Date; payee: string | null }

/** Identity of the recipient used for "is this a new payee": the resolved destination, never a display name. */
export function payeeKey(destination: unknown): string | null {
  const d = (destination ?? {}) as Record<string, unknown>;
  if (typeof d.toAccountId === 'string') return `acct:${d.toAccountId}`;
  if (typeof d.accountNumber === 'string') return `ext:${String(d.bankCode ?? '')}:${d.accountNumber}`;
  if (typeof d.billerCode === 'string') return `bill:${d.billerCode}:${String(d.billRef ?? '')}`;
  return null;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/**
 * Pure rule evaluation. Everything a rule needs is passed in, so each rule is unit-testable and every hit carries the
 * numbers that triggered it. Rules only DESCRIBE; nothing here can block, reverse or restrict anything.
 */
export function evaluate(p: PaymentFacts, ctx: { cfg: RiskConfig; recentCount: number; knownPayees: ReadonlySet<string>; newDeviceAt: Date | null; history: number[] }): Hit[] {
  const hits: Hit[] = [];
  const amt = num(p.amountMinor);
  if (amt >= ctx.cfg.highValueMinor)
    hits.push({ ruleCode: 'HIGH_VALUE', severity: amt >= ctx.cfg.highValueMinor * 5 ? 'HIGH' : 'MEDIUM', summary: `High-value payment of ${lkr(p.amountMinor)}`, details: { amountMinor: amt, thresholdMinor: ctx.cfg.highValueMinor } });
  if (ctx.recentCount === ctx.cfg.velocityCount)
    hits.push({ ruleCode: 'VELOCITY', severity: 'MEDIUM', summary: `${ctx.recentCount} payments within 10 minutes`, details: { count: ctx.recentCount, windowMinutes: 10, threshold: ctx.cfg.velocityCount } });
  if (p.payee && !ctx.knownPayees.has(p.payee) && amt >= ctx.cfg.newPayeeMinor)
    hits.push({ ruleCode: 'NEW_PAYEE_LARGE', severity: 'MEDIUM', summary: `First payment to a new recipient: ${lkr(p.amountMinor)}`, details: { amountMinor: amt, thresholdMinor: ctx.cfg.newPayeeMinor } });
  if (ctx.newDeviceAt && amt >= ctx.cfg.newDeviceMinor)
    hits.push({ ruleCode: 'NEW_DEVICE_ACTIVITY', severity: 'MEDIUM', summary: `Large payment within 24 hours of a new device being added`, details: { amountMinor: amt, thresholdMinor: ctx.cfg.newDeviceMinor, deviceAddedAt: ctx.newDeviceAt.toISOString() } });
  if (ctx.cfg.anomalyEnabled && ctx.history.length >= 10) {
    const m = median(ctx.history);
    const mad = median(ctx.history.map((x) => Math.abs(x - m)));
    if (mad > 0) {
      const z = (0.6745 * (amt - m)) / mad; // robust z-score: one earlier large payment does not hide the next
      if (z >= 6 && amt >= 3 * m)
        hits.push({ ruleCode: 'ANOMALY_EXPERIMENT', severity: 'LOW', summary: `Unusually large compared with this customer's last ${ctx.history.length} payments (experimental)`, details: { amountMinor: amt, medianMinor: Math.round(m), robustZ: Math.round(z * 10) / 10, sample: ctx.history.length, note: 'Statistical experiment. Not a certified control; for staff review only.' } });
    }
  }
  return hits;
}

@Injectable()
export class RiskService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async config(): Promise<RiskConfig> {
    const rows = await this.prisma.systemConfiguration.findMany({ where: { key: { startsWith: 'risk.' } } });
    const get = <T>(k: string, d: T): T => { const v = rows.find((r) => r.key === `risk.${k}`)?.value; return v === undefined || v === null || typeof v !== typeof d ? d : (v as T); };
    return { highValueMinor: get('highValueMinor', RISK_DEFAULTS.highValueMinor), velocityCount: get('velocityCount', RISK_DEFAULTS.velocityCount), newPayeeMinor: get('newPayeeMinor', RISK_DEFAULTS.newPayeeMinor), newDeviceMinor: get('newDeviceMinor', RISK_DEFAULTS.newDeviceMinor), anomalyEnabled: get('anomalyEnabled', RISK_DEFAULTS.anomalyEnabled) };
  }

  /**
   * Looks at recently posted payments. Runs from the background job, completely outside the payment path: a risk rule
   * can be slow or broken and no payment is ever delayed, blocked or changed. Re-running is safe: (rule, payment) is unique.
   */
  async scan(now = new Date()): Promise<{ scanned: number; raised: number }> {
    const cfg = await this.config();
    const since = new Date(now.getTime() - 3 * 3_600_000);
    const payments = await this.prisma.paymentInstruction.findMany({ where: { status: 'POSTED', postedAt: { gte: since }, kind: { not: 'OWN_TRANSFER' } }, orderBy: { postedAt: 'asc' }, take: 1000 });
    let raised = 0;
    const staff = await this.reviewers();
    for (const p of payments) {
      const postedAt = p.postedAt!;
      const [recentCount, prior, devices] = await Promise.all([
        this.prisma.paymentInstruction.count({ where: { initiatorId: p.initiatorId, status: 'POSTED', kind: { not: 'OWN_TRANSFER' }, postedAt: { gt: new Date(postedAt.getTime() - 10 * MIN), lte: postedAt } } }),
        this.prisma.paymentInstruction.findMany({ where: { initiatorId: p.initiatorId, status: 'POSTED', kind: { not: 'OWN_TRANSFER' }, postedAt: { gte: new Date(postedAt.getTime() - 90 * DAY), lt: postedAt } }, select: { destination: true, amountMinor: true }, take: 500 }),
        this.prisma.trustedDevice.findMany({ where: { userId: p.initiatorId, revokedAt: null }, select: { trustedAt: true } }),
      ]);
      // "New device" only means something if the customer already had older devices (the first device is just onboarding).
      const newest = devices.map((d) => d.trustedAt).filter((t) => t <= postedAt && postedAt.getTime() - t.getTime() < DAY).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const hasOlder = devices.some((d) => postedAt.getTime() - d.trustedAt.getTime() >= DAY);
      const hits = evaluate(
        { id: p.id, initiatorId: p.initiatorId, amountMinor: p.amountMinor, postedAt, payee: payeeKey(p.destination) },
        { cfg, recentCount, knownPayees: new Set(prior.map((x) => payeeKey(x.destination)).filter((x): x is string => !!x)), newDeviceAt: hasOlder ? newest : null, history: prior.map((x) => num(x.amountMinor)) },
      );
      for (const h of hits) {
        try {
          await this.prisma.$transaction(async (tx) => {
            const a = await tx.riskAlert.create({ data: { ruleCode: h.ruleCode, severity: h.severity, customerId: p.initiatorId, paymentId: p.id, summary: h.summary, details: h.details as Prisma.InputJsonValue } });
            if (h.severity === 'HIGH') await queueNotifications(tx, 'risk.alert', staff.map((userId) => ({ userId, category: 'SECURITY', title: 'High-severity risk alert', body: `${h.summary}. Open Risk alerts to review.` })), { alertId: a.id });
          });
          raised++;
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // already raised on an earlier scan
        }
      }
    }
    return { scanned: payments.length, raised };
  }

  private async reviewers(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({ where: { type: 'STAFF', status: 'ACTIVE', roles: { some: { role: { permissions: { some: { permission: { key: 'risk.review' } } } } } } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  // ───────────────────────── staff review ─────────────────────────
  private view(a: { id: string; ruleCode: string; severity: string; customerId: string; paymentId: string | null; summary: string; details: Prisma.JsonValue; status: string; assignedToId: string | null; resolutionNote: string | null; createdAt: Date; resolvedAt: Date | null }, customer?: { fullName: string; customerNumber: string }) {
    return { id: a.id, ruleCode: a.ruleCode, severity: a.severity, summary: a.summary, details: a.details, status: a.status, assignedToId: a.assignedToId, resolutionNote: a.resolutionNote, paymentId: a.paymentId, customerId: a.customerId, customerName: customer?.fullName, customerNumber: customer?.customerNumber, createdAt: a.createdAt, resolvedAt: a.resolvedAt };
  }

  async list(status: string) {
    const s = ['OPEN', 'INVESTIGATING', 'CLEARED', 'ESCALATED'].includes(status) ? status : 'OPEN';
    const rows = await this.prisma.riskAlert.findMany({ where: { status: s }, orderBy: [{ createdAt: 'desc' }], take: 100 });
    const customers = new Map((await this.prisma.customerProfile.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.customerId))] } } })).map((c) => [c.userId, c]));
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
    return { items: rows.map((r) => this.view(r, customers.get(r.customerId))).sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)) };
  }

  async take(staffId: string, id: string) {
    const r = await this.prisma.riskAlert.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'INVESTIGATING', assignedToId: staffId } });
    if (r.count !== 1) throw new ConflictException({ code: 'not_open', message: 'This alert is not waiting for review' });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'risk.investigating', subjectType: 'RiskAlert', subjectId: id });
    return { id, status: 'INVESTIGATING' };
  }

  /** CLEARED (false alarm) or ESCALATED (needs action by someone with the right permission). A written note is mandatory. */
  async resolve(staffId: string, id: string, status: 'CLEARED' | 'ESCALATED', note: string) {
    if (note.trim().length < 5) throw new UnprocessableEntityException({ code: 'note_required', message: 'Explain your decision in a few words' });
    const r = await this.prisma.riskAlert.updateMany({ where: { id, status: { in: ['OPEN', 'INVESTIGATING'] } }, data: { status, resolutionNote: note.trim(), resolvedById: staffId, resolvedAt: new Date() } });
    if (r.count !== 1) {
      if (!(await this.prisma.riskAlert.findUnique({ where: { id } }))) throw new NotFoundException({ code: 'not_found', message: 'Alert not found' });
      throw new ConflictException({ code: 'already_resolved', message: 'This alert was already resolved' });
    }
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: `risk.${status.toLowerCase()}`, subjectType: 'RiskAlert', subjectId: id, reasonCode: note.slice(0, 100) });
    return { id, status };
  }

  async summary() {
    const [open, byRule] = await Promise.all([
      this.prisma.riskAlert.groupBy({ by: ['severity'], where: { status: { in: ['OPEN', 'INVESTIGATING'] } }, _count: true }),
      this.prisma.riskAlert.groupBy({ by: ['ruleCode'], where: { createdAt: { gte: new Date(Date.now() - 30 * DAY) } }, _count: true }),
    ]);
    return { openBySeverity: Object.fromEntries(open.map((o) => [o.severity, o._count])), last30DaysByRule: Object.fromEntries(byRule.map((o) => [o.ruleCode, o._count])) };
  }
}
