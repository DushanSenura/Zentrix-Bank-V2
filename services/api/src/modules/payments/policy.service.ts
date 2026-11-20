import { Injectable } from '@nestjs/common';
import type { PaymentKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

/** Bank-controlled fees and limits. Defaults are the V1 product rules; override via SystemConfiguration rows. */
export const POLICY_DEFAULTS = {
  'fees.interbankMinor': 2500, // LKR 25
  'limits.perTransferMinor': 50_000_000, // LKR 500,000
  'limits.dailyTransferMinor': 50_000_000, // LKR 500,000 per day across outgoing payments
} as const;
type Key = keyof typeof POLICY_DEFAULTS;

@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  private async num(key: Key): Promise<bigint> {
    const row = await this.prisma.systemConfiguration.findUnique({ where: { key } });
    const v = typeof row?.value === 'number' && Number.isInteger(row.value) && row.value >= 0 ? row.value : POLICY_DEFAULTS[key];
    return BigInt(v);
  }

  /** Fees are ALWAYS computed here; a client-supplied fee is never read. */
  async feeFor(kind: PaymentKind, _amountMinor: bigint): Promise<bigint> {
    return kind === 'INTERBANK_TRANSFER' ? this.num('fees.interbankMinor') : 0n;
  }

  /** Bank limits, with the customer's own (lower) daily limit applied when a customer is given. A customer can never get more than the bank allows. */
  async limits(customerId?: string): Promise<{ perTransferMinor: bigint; dailyMinor: bigint }> {
    const bank = await this.num('limits.dailyTransferMinor');
    let daily = bank;
    if (customerId) {
      const own = await this.prisma.customerPreference.findUnique({ where: { customerId }, select: { dailyLimitMinor: true } });
      if (own?.dailyLimitMinor !== null && own?.dailyLimitMinor !== undefined && own.dailyLimitMinor < bank) daily = own.dailyLimitMinor;
    }
    return { perTransferMinor: await this.num('limits.perTransferMinor'), dailyMinor: daily };
  }
}

/** Start of the current banking day in Sri Lanka (UTC+05:30), as a UTC instant. */
export function startOfBankingDay(now: Date): Date {
  const OFFSET = 5.5 * 3_600_000;
  const local = new Date(now.getTime() + OFFSET);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - OFFSET);
}
