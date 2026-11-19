import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ErrorFilter } from './common/error.filter';
import { CoreModule } from './common/prisma.module';
import { AuthController } from './modules/auth/auth.controller';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token.service';
import { AdminKycController } from './modules/customers/admin-kyc.controller';
import { MeController } from './modules/customers/me.controller';
import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [
    CoreModule,
    // skipIf: automated tests drive many logins from one IP; production/dev always enforce.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 240 }], skipIf: () => process.env.NODE_ENV === 'test' }),
  ],
  controllers: [HealthController, AuthController, MeController, AdminKycController],
  providers: [
    AuthService,
    TokenService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
