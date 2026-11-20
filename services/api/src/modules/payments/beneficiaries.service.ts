import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { queueNotifications } from '../../common/notify';
import { PrismaService } from '../../common/prisma.service';
import { masked } from '../accounts/accounts.service';
import { bankName, SIMULATED_BANKS } from './catalog';

export interface NewBeneficiary {
  bankCode: string;
  accountNumber: string;
  holderName?: string;
  nickname?: string;
}

/** Simulated external name-check: numbers ending 0000 are "unverifiable" (kept from V1 as a test hook). */
export const externalAccountProblem = (n: string): string | null => (/0000$/.test(n) ? 'We could not verify that account number' : null);

@Injectable()
export class BeneficiariesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private view(b: { id: string; bankCode: string; accountNumber: string; holderName: string; nickname: string | null; favorite: boolean }) {
    return { id: b.id, bankCode: b.bankCode, bankName: bankName(b.bankCode), accountNumberMasked: masked(b.accountNumber), holderName: b.holderName, nickname: b.nickname, favorite: b.favorite };
  }

  async list(customerId: string) {
    const rows = await this.prisma.beneficiary.findMany({ where: { customerId, deletedAt: null }, orderBy: [{ favorite: 'desc' }, { holderName: 'asc' }] });
    return { items: rows.map((r) => this.view(r)) };
  }

  /** "Save this recipient" from a finished payment. The full account number comes from the stored payment, never from the client. */
  async saveFromPayment(customerId: string, paymentId: string, nickname?: string) {
    const pay = await this.prisma.paymentInstruction.findUnique({ where: { id: paymentId } });
    if (!pay || pay.initiatorId !== customerId) throw new NotFoundException({ code: 'not_found', message: 'Payment not found' });
    const d = (pay.destination ?? {}) as Record<string, unknown>;
    if (pay.status !== 'POSTED') throw new ConflictException({ code: 'not_saveable', message: 'Only a completed payment can be saved as a recipient' });
    if (d.settle === 'INTERBANK') return this.add(customerId, { bankCode: d.bankCode as string, accountNumber: d.accountNumber as string, holderName: d.name as string, nickname });
    if (d.settle === 'INTERNAL' && typeof d.toAccountId === 'string') {
      const to = await this.prisma.account.findUnique({ where: { id: d.toAccountId } });
      if (to) return this.add(customerId, { bankCode: 'ZENTRIX', accountNumber: to.accountNumber, nickname });
    }
    throw new ConflictException({ code: 'not_saveable', message: 'This payment has no recipient to save' });
  }

  /** Resolves the holder name SERVER-side for Zentrix accounts; the client cannot assert who owns an account. */
  async add(customerId: string, b: NewBeneficiary) {
    let holderName: string;
    if (b.bankCode === 'ZENTRIX') {
      if (!/^\d{11}$/.test(b.accountNumber)) throw new BadRequestException({ code: 'validation_failed', message: 'Enter a valid account number', fields: { accountNumber: 'Enter a valid account number' } });
      const acc = await this.prisma.account.findUnique({ where: { accountNumber: b.accountNumber }, include: { customer: true } });
      if (!acc || acc.status === 'CLOSED') throw new NotFoundException({ code: 'recipient_not_found', message: 'No Zentrix account matches that number' });
      if (acc.customerId === customerId) throw new BadRequestException({ code: 'own_account', message: 'That is one of your own accounts' });
      holderName = acc.customer.fullName;
    } else {
      if (!SIMULATED_BANKS.some((s) => s.code === b.bankCode)) throw new BadRequestException({ code: 'validation_failed', message: 'Unknown bank', fields: { bankCode: 'Unknown bank' } });
      if (!/^\d{8,16}$/.test(b.accountNumber)) throw new BadRequestException({ code: 'validation_failed', message: 'Enter a valid account number', fields: { accountNumber: '8-16 digits' } });
      const problem = externalAccountProblem(b.accountNumber);
      if (problem) throw new BadRequestException({ code: 'unverifiable_account', message: problem, fields: { accountNumber: problem } });
      if (!b.holderName) throw new BadRequestException({ code: 'validation_failed', message: 'Enter the account holder name', fields: { holderName: 'Required' } });
      holderName = b.holderName;
    }
    try {
      const row = await this.prisma.beneficiary.create({ data: { customerId, bankCode: b.bankCode, accountNumber: b.accountNumber, holderName, nickname: b.nickname } });
      await this.audit.record({ actorId: customerId, actorType: 'CUSTOMER', action: 'beneficiary.added', subjectType: 'Beneficiary', subjectId: row.id });
      await queueNotifications(this.prisma, 'beneficiary.added', [{ userId: customerId, category: 'ACCOUNT', title: 'New recipient saved', body: `${holderName} was added to your saved recipients.` }]);
      return this.view(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.beneficiary.findUniqueOrThrow({ where: { customerId_bankCode_accountNumber: { customerId, bankCode: b.bankCode, accountNumber: b.accountNumber } } });
        if (existing.deletedAt) return this.view(await this.prisma.beneficiary.update({ where: { id: existing.id }, data: { deletedAt: null, holderName, nickname: b.nickname } })); // revive
        throw new ConflictException({ code: 'duplicate', message: 'You already saved this recipient' });
      }
      throw e;
    }
  }

  async update(customerId: string, id: string, d: { nickname?: string | null; favorite?: boolean }) {
    const r = await this.prisma.beneficiary.updateMany({ where: { id, customerId, deletedAt: null }, data: { ...(d.nickname !== undefined ? { nickname: d.nickname } : {}), ...(d.favorite !== undefined ? { favorite: d.favorite } : {}) } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Recipient not found' });
    return this.view(await this.prisma.beneficiary.findUniqueOrThrow({ where: { id } }));
  }

  async remove(customerId: string, id: string) {
    const r = await this.prisma.beneficiary.updateMany({ where: { id, customerId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException({ code: 'not_found', message: 'Recipient not found' });
  }

  /** Internal: fetch a saved beneficiary only if it belongs to the caller. */
  async getOwned(customerId: string, id: string) {
    const b = await this.prisma.beneficiary.findFirst({ where: { id, customerId, deletedAt: null } });
    if (!b) throw new NotFoundException({ code: 'recipient_not_found', message: 'Recipient not found' });
    return b;
  }
}
