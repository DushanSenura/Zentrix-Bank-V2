-- AlterTable
ALTER TABLE "AccountApplication" ADD COLUMN     "accountId" UUID,
ADD COLUMN     "openingDepositMinor" BIGINT;

-- AlterTable
ALTER TABLE "LedgerAccount" ADD COLUMN     "allowNegative" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "balanceMinor" BIGINT NOT NULL DEFAULT 0;
