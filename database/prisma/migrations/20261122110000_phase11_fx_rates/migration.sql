-- CreateTable
CREATE TABLE "FxRate" (
    "currency" TEXT NOT NULL,
    "midRateMicro" BIGINT NOT NULL,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("currency")
);

