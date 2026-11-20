-- CreateTable
CREATE TABLE "CustomerPreference" (
    "customerId" UUID NOT NULL,
    "defaultAccountId" UUID,
    "mutedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailyLimitMinor" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPreference_pkey" PRIMARY KEY ("customerId")
);

