-- AlterTable
ALTER TABLE "AccountApplication" ADD COLUMN     "fundingAccountId" UUID,
ADD COLUMN     "fundingAmountMinor" BIGINT;

-- AlterTable
ALTER TABLE "AuthenticationChallenge" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PaymentInstruction" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "autoLastFailure" TEXT,
ADD COLUMN     "autoNextRunAt" TIMESTAMP(3),
ADD COLUMN     "autoSourceAccountId" UUID,
ADD COLUMN     "monthlyAutoMinor" BIGINT;

