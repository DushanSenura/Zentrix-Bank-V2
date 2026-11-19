-- CreateEnum
CREATE TYPE "CardKind" AS ENUM ('DEBIT', 'VIRTUAL', 'CREDIT');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('PENDING_APPROVAL', 'PREPARING', 'READY_TO_COLLECT', 'ACTIVE', 'FROZEN', 'BLOCKED', 'REJECTED');

-- CreateTable
CREATE TABLE "Branch" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'BRANCH',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "kind" "CardKind" NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'VISA',
    "status" "CardStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "holderName" TEXT NOT NULL,
    "last4" TEXT,
    "expiryMonth" INTEGER,
    "expiryYear" INTEGER,
    "token" TEXT,
    "pinHash" TEXT,
    "collectionBranchId" UUID,
    "readyOn" TIMESTAMP(3),
    "creditLimitMinor" BIGINT,
    "application" JSONB,
    "decisionReason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardControls" (
    "cardId" UUID NOT NULL,
    "dailyLimitMinor" BIGINT NOT NULL DEFAULT 10000000,
    "onlineEnabled" BOOLEAN NOT NULL DEFAULT true,
    "internationalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "contactlessEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CardControls_pkey" PRIMARY KEY ("cardId")
);

-- CreateTable
CREATE TABLE "CardStatusHistory" (
    "id" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "fromStatus" "CardStatus",
    "toStatus" "CardStatus" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedDepositRate" (
    "id" UUID NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "minAmountMinor" BIGINT NOT NULL DEFAULT 1000000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedDepositRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedDeposit" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "fundingAccountId" UUID NOT NULL,
    "ledgerAccountId" UUID NOT NULL,
    "originalPrincipalMinor" BIGINT NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "renewal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "renewalCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedDepositRenewal" (
    "id" UUID NOT NULL,
    "fixedDepositId" UUID NOT NULL,
    "interestMinor" BIGINT NOT NULL,
    "newPrincipalMinor" BIGINT NOT NULL,
    "newMaturityDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedDepositRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedDepositClosureRequest" (
    "id" UUID NOT NULL,
    "fixedDepositId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "decisionReason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "payoutMinor" BIGINT,
    "penaltyMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedDepositClosureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanProduct" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minAmountMinor" BIGINT NOT NULL,
    "maxAmountMinor" BIGINT NOT NULL,
    "minTermMonths" INTEGER NOT NULL,
    "maxTermMonths" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LoanProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanApplication" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "monthlyIncomeMinor" BIGINT NOT NULL,
    "employment" TEXT NOT NULL,
    "purpose" TEXT,
    "disbursementAccountId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "assessment" JSONB,
    "decisionReason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "approvalRequestId" UUID,
    "loanId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "applicationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "disbursementAccountId" UUID NOT NULL,
    "ledgerAccountId" UUID NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanRepaymentSchedule" (
    "id" UUID NOT NULL,
    "loanId" UUID NOT NULL,
    "instalmentNo" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "interestMinor" BIGINT NOT NULL,
    "paidPrincipalMinor" BIGINT NOT NULL DEFAULT 0,
    "paidInterestMinor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LoanRepaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanPayment" (
    "id" UUID NOT NULL,
    "loanId" UUID NOT NULL,
    "paymentId" UUID,
    "amountMinor" BIGINT NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "interestMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "targetMinor" BIGINT NOT NULL,
    "targetDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ledgerAccountId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "limitMinor" BIGINT NOT NULL,
    "alertLevel" INTEGER NOT NULL DEFAULT 0,
    "alertMonth" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Card_token_key" ON "Card"("token");

-- CreateIndex
CREATE INDEX "Card_customerId_status_idx" ON "Card"("customerId", "status");

-- CreateIndex
CREATE INDEX "Card_status_createdAt_idx" ON "Card"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CardStatusHistory_cardId_createdAt_idx" ON "CardStatusHistory"("cardId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FixedDepositRate_termMonths_key" ON "FixedDepositRate"("termMonths");

-- CreateIndex
CREATE UNIQUE INDEX "FixedDeposit_reference_key" ON "FixedDeposit"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "FixedDeposit_ledgerAccountId_key" ON "FixedDeposit"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "FixedDeposit_customerId_status_idx" ON "FixedDeposit"("customerId", "status");

-- CreateIndex
CREATE INDEX "FixedDeposit_status_maturityDate_idx" ON "FixedDeposit"("status", "maturityDate");

-- CreateIndex
CREATE INDEX "FixedDepositClosureRequest_status_createdAt_idx" ON "FixedDepositClosureRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_code_key" ON "LoanProduct"("code");

-- CreateIndex
CREATE INDEX "LoanApplication_status_createdAt_idx" ON "LoanApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "LoanApplication_customerId_idx" ON "LoanApplication"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_reference_key" ON "Loan"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_applicationId_key" ON "Loan"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_ledgerAccountId_key" ON "Loan"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "Loan_customerId_status_idx" ON "Loan"("customerId", "status");

-- CreateIndex
CREATE INDEX "LoanRepaymentSchedule_status_dueDate_idx" ON "LoanRepaymentSchedule"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "LoanRepaymentSchedule_loanId_instalmentNo_key" ON "LoanRepaymentSchedule"("loanId", "instalmentNo");

-- CreateIndex
CREATE UNIQUE INDEX "LoanPayment_paymentId_key" ON "LoanPayment"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsGoal_ledgerAccountId_key" ON "SavingsGoal"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "SavingsGoal_customerId_status_idx" ON "SavingsGoal"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_customerId_category_key" ON "Budget"("customerId", "category");

-- AddForeignKey
ALTER TABLE "CardControls" ADD CONSTRAINT "CardControls_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardStatusHistory" ADD CONSTRAINT "CardStatusHistory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedDepositRenewal" ADD CONSTRAINT "FixedDepositRenewal_fixedDepositId_fkey" FOREIGN KEY ("fixedDepositId") REFERENCES "FixedDeposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedDepositClosureRequest" ADD CONSTRAINT "FixedDepositClosureRequest_fixedDepositId_fkey" FOREIGN KEY ("fixedDepositId") REFERENCES "FixedDeposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepaymentSchedule" ADD CONSTRAINT "LoanRepaymentSchedule_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

