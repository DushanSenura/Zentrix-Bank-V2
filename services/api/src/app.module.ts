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
import { PinService } from './modules/auth/pin.service';
import { BeneficiariesService } from './modules/payments/beneficiaries.service';
import { AdminPaymentsController, InternalJobsController, NotificationsController, PaymentsController } from './modules/payments/payments.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { PolicyService } from './modules/payments/policy.service';
import { AdminCardsController, CardsController } from './modules/cards/cards.controller';
import { CardsService } from './modules/cards/cards.service';
import { AdminDepositsController, DepositsController } from './modules/deposits/deposits.controller';
import { DepositsService } from './modules/deposits/deposits.service';
import { AdminLoansController, LoansController } from './modules/loans/loans.controller';
import { LoansService } from './modules/loans/loans.service';
import { SavingsController } from './modules/savings/savings.controller';
import { SavingsService } from './modules/savings/savings.service';
import { AdminLedgerOpsController, AdminOverviewController, AdminSettingsController, AdminStaffController, StaffSetupController, SystemController } from './modules/admin/admin.controller';
import { LedgerOpsService } from './modules/admin/ledger-ops.service';
import { OverviewService } from './modules/admin/overview.service';
import { MaintenanceService, SettingsService } from './modules/admin/settings.service';
import { StaffService } from './modules/admin/staff.service';
import { AdminSupportController, SupportController } from './modules/support/support.controller';
import { SupportService } from './modules/support/support.service';
import { LocalDiskStorage, OBJECT_STORAGE } from './modules/support/storage';
import { ExtrasController } from './modules/payments/extras.controller';
import { ExtrasService } from './modules/payments/extras.service';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { AdminKycController } from './modules/customers/admin-kyc.controller';
import { MeController } from './modules/customers/me.controller';
import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [
    CoreModule,
    // skipIf: automated tests drive many logins from one IP; production/dev always enforce.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 240 }], skipIf: () => process.env.NODE_ENV === 'test' }),
  ],
  controllers: [HealthController, AuthController, SecurityController, MeController, AdminKycController, AccountsController, AdminAccountsController, PaymentsController, NotificationsController, AdminPaymentsController, InternalJobsController, CardsController, AdminCardsController, DepositsController, AdminDepositsController, LoansController, AdminLoansController, SavingsController, AdminOverviewController, AdminSettingsController, SystemController, AdminStaffController, StaffSetupController, AdminLedgerOpsController, SupportController, AdminSupportController, DocumentsController, ExtrasController],
  providers: [
    AuthService,
    LedgerService,
    AccountsService,
    PinService,
    PolicyService,
    BeneficiariesService,
    PaymentsService,
    CardsService,
    DepositsService,
    LoansService,
    SavingsService,
    OverviewService,
    SettingsService,
    MaintenanceService,
    StaffService,
    LedgerOpsService,
    SupportService,
    DocumentsService,
    ExtrasService,
    { provide: OBJECT_STORAGE, useClass: LocalDiskStorage },
    TokenService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
