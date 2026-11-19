import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ErrorFilter } from './common/error.filter';
import { CoreModule } from './common/prisma.module';
import { AuthController } from './modules/auth/auth.controller';
import { SecurityController } from './modules/auth/security.controller';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token.service';
import { AccountsController, AdminAccountsController } from './modules/accounts/accounts.controller';
import { AccountsService } from './modules/accounts/accounts.service';
import { LedgerService } from './modules/ledger/ledger.service';
import { AdminKycController } from './modules/customers/admin-kyc.controller';
import { MeController } from './modules/customers/me.controller';
import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [
    CoreModule,
    // skipIf: automated tests drive many logins from one IP; production/dev always enforce.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 240 }], skipIf: () => process.env.NODE_ENV === 'test' }),
  ],
  controllers: [HealthController, AuthController, SecurityController, MeController, AdminKycController, AccountsController, AdminAccountsController],
  providers: [
    AuthService,
    LedgerService,
    AccountsService,
    TokenService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
