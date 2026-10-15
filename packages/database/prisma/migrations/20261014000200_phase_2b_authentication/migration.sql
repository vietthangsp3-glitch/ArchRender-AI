-- CreateEnum
CREATE TYPE "LoginAttemptOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'BLOCKED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "ownerSingletonKey" VARCHAR(32);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "identifierHash" VARCHAR(128) NOT NULL,
    "ipHash" VARCHAR(128) NOT NULL,
    "outcome" "LoginAttemptOutcome" NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_ownerSingletonKey_key" ON "User"("ownerSingletonKey");

-- CreateIndex
CREATE INDEX "LoginAttempt_identifierHash_createdAt_idx" ON "LoginAttempt"("identifierHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_identifierHash_ipHash_createdAt_idx" ON "LoginAttempt"("identifierHash", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_blockedUntil_idx" ON "LoginAttempt"("blockedUntil");

-- AddForeignKey
ALTER TABLE "LoginAttempt" ADD CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
