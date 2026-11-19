import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { POLICY_DEFAULTS } from '../payments/policy.service';

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: 'int' | 'bool' | 'string';
  min?: number;
  max?: number;
  default: number | boolean | string;
  help?: string;
}

/** The ONLY keys staff can change from the portal. Anything else is rejected, so config cannot be used as a back door. */
export const SETTING_DEFS: SettingDef[] = [
  { key: 'fees.interbankMinor', label: 'Other-bank transfer fee', group: 'Fees', type: 'int', min: 0, max: 10_000_000, default: POLICY_DEFAULTS['fees.interbankMinor'], help: 'Minor units (cents). 2500 = LKR 25.00' },
  { key: 'limits.perTransferMinor', label: 'Limit per payment', group: 'Limits', type: 'int', min: 100, max: 100_000_000_000, default: POLICY_DEFAULTS['limits.perTransferMinor'], help: 'Minor units' },
  { key: 'limits.dailyTransferMinor', label: 'Daily outgoing limit per customer', group: 'Limits', type: 'int', min: 100, max: 100_000_000_000, default: POLICY_DEFAULTS['limits.dailyTransferMinor'], help: 'Minor units; own-account moves and loan repayments are exempt' },
  { key: 'accounts.maxPerCustomer', label: 'Maximum accounts per customer', group: 'Accounts', type: 'int', min: 1, max: 50, default: 6 },
  { key: 'cards.maxDailyLimitMinor', label: 'Maximum card daily limit', group: 'Cards', type: 'int', min: 0, max: 100_000_000_000, default: 50_000_000, help: 'Minor units' },
  { key: 'fd.earlyPenaltyBps', label: 'Fixed deposit early-closure penalty', group: 'Deposits', type: 'int', min: 0, max: 5000, default: 300, help: 'Basis points taken off the rate (300 = 3.00 points)' },
  { key: 'adjustments.maxMinor', label: 'Maximum single ledger adjustment', group: 'Operations', type: 'int', min: 100, max: 100_000_000_000, default: 10_000_000, help: 'Minor units. Adjustments always need a second approver.' },
  { key: 'risk.highValueMinor', label: 'High-value payment alert threshold', group: 'Risk', type: 'int', min: 100, max: 100_000_000_000, default: 50_000_000, help: 'Minor units. Payments at or above this raise an alert for staff review. Alerts never block a payment.' },
  { key: 'risk.velocityCount', label: 'Rapid payments alert (count in 10 minutes)', group: 'Risk', type: 'int', min: 2, max: 100, default: 5 },
  { key: 'risk.newPayeeMinor', label: 'Large first payment to a new payee', group: 'Risk', type: 'int', min: 100, max: 100_000_000_000, default: 20_000_000, help: 'Minor units' },
  { key: 'risk.newDeviceMinor', label: 'Large payment soon after a new device', group: 'Risk', type: 'int', min: 100, max: 100_000_000_000, default: 10_000_000, help: 'Minor units; looks at devices added in the last 24 hours' },
  { key: 'risk.anomalyEnabled', label: 'Anomaly detection experiment', group: 'Risk', type: 'bool', default: false, help: 'Statistical experiment, not a certified control. It only raises explainable alerts for review.' },
  { key: 'maintenance.enabled', label: 'Maintenance mode', group: 'System', type: 'bool', default: false, help: 'Customers see a maintenance notice; staff can still sign in.' },
  { key: 'maintenance.message', label: 'Maintenance message', group: 'System', type: 'string', max: 200, default: 'Zentrix Bank is being updated. Please try again shortly.' },
];

const DEF = new Map(SETTING_DEFS.map((d) => [d.key, d]));

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list() {
    const rows = await this.prisma.systemConfiguration.findMany({ where: { key: { in: SETTING_DEFS.map((d) => d.key) } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return { items: SETTING_DEFS.map((d) => ({ ...d, value: byKey.get(d.key)?.value ?? d.default, isDefault: !byKey.has(d.key), updatedAt: byKey.get(d.key)?.updatedAt ?? null })) };
  }

  async set(staffId: string, key: string, value: unknown) {
    const d = DEF.get(key);
    if (!d) throw new BadRequestException({ code: 'unknown_setting', message: 'That setting does not exist' });
    if (d.type === 'int') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < (d.min ?? 0) || value > (d.max ?? Number.MAX_SAFE_INTEGER))
        throw new BadRequestException({ code: 'validation_failed', message: `${d.label} must be a whole number between ${d.min ?? 0} and ${d.max}`, fields: { value: 'Out of range' } });
    } else if (d.type === 'bool') {
      if (typeof value !== 'boolean') throw new BadRequestException({ code: 'validation_failed', message: `${d.label} must be true or false`, fields: { value: 'Invalid' } });
    } else if (typeof value !== 'string' || value.trim().length === 0 || value.length > (d.max ?? 200)) {
      throw new BadRequestException({ code: 'validation_failed', message: `${d.label} must be 1-${d.max ?? 200} characters`, fields: { value: 'Invalid' } });
    }
    const before = await this.prisma.systemConfiguration.findUnique({ where: { key } });
    await this.prisma.systemConfiguration.upsert({ where: { key }, update: { value: value as never, updatedBy: staffId }, create: { key, value: value as never, updatedBy: staffId } });
    await this.audit.record({ actorId: staffId, actorType: 'STAFF', action: 'settings.changed', subjectType: 'SystemConfiguration', subjectId: key, metadata: { from: (before?.value ?? d.default) as never, to: value as never } });
    MaintenanceService.invalidate();
    return { key, value };
  }
}

/** Reads the maintenance flag with a 5 s cache so the guard adds no database round trip to most requests. */
@Injectable()
export class MaintenanceService {
  private static cache: { at: number; enabled: boolean; message: string } | null = null;
  constructor(private readonly prisma: PrismaService) {}

  static invalidate() { MaintenanceService.cache = null; }

  async status(): Promise<{ enabled: boolean; message: string }> {
    const c = MaintenanceService.cache;
    if (c && Date.now() - c.at < 5000) return c;
    const rows = await this.prisma.systemConfiguration.findMany({ where: { key: { in: ['maintenance.enabled', 'maintenance.message'] } } });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    const fresh = { at: Date.now(), enabled: get('maintenance.enabled') === true, message: typeof get('maintenance.message') === 'string' ? (get('maintenance.message') as string) : String(DEF.get('maintenance.message')!.default) };
    MaintenanceService.cache = fresh;
    return fresh;
  }
}
