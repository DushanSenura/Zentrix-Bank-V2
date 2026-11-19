-- CreateTable
CREATE TABLE "RiskAlert" (
    "id" UUID NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "paymentId" UUID,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedToId" UUID,
    "resolutionNote" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "dueKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskAlert_status_createdAt_idx" ON "RiskAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RiskAlert_customerId_createdAt_idx" ON "RiskAlert"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAlert_ruleCode_paymentId_key" ON "RiskAlert"("ruleCode", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_kind_subjectId_dueKey_key" ON "ReminderLog"("kind", "subjectId", "dueKey");

