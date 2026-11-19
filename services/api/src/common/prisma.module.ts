import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from '../config/env';
import { AuditService } from './audit.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, { provide: ENV, useFactory: () => loadEnv() }],
  exports: [PrismaService, AuditService, ENV],
})
export class CoreModule {}
