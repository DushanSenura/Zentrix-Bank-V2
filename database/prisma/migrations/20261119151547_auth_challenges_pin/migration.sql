-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "pinSetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuthenticationChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthenticationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthenticationChallenge_tokenHash_key" ON "AuthenticationChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthenticationChallenge_userId_purpose_idx" ON "AuthenticationChallenge"("userId", "purpose");

-- AddForeignKey
ALTER TABLE "AuthenticationChallenge" ADD CONSTRAINT "AuthenticationChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
