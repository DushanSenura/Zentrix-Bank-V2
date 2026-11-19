import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  actorType: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
  action: string;
  subjectType?: string;
  subjectId?: string;
  reasonCode?: string;
  /** Must already be free of secrets/PII. */
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(e: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    await (tx ?? this.prisma).auditLog.create({ data: { ...e, actorId: e.actorId ?? null } });
  }

  async securityEvent(kind: string, userId: string | null, detail?: Prisma.InputJsonValue, severity = 'WARN'): Promise<void> {
    await this.prisma.securityEvent.create({ data: { kind, userId, detail, severity } });
  }
}
