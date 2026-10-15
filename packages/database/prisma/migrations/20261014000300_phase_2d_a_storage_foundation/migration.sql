-- Milestone 2D-A review-only migration.
-- Operator checkpoint: review and apply manually. Do not use db push or migrate reset.

-- Extend enums without removing or renaming legacy values.
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'SOURCE_IMAGE' BEFORE 'SOURCE_RENDER';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'REFERENCE_IMAGE' AFTER 'SOURCE_IMAGE';
ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'CANNY_MAP' AFTER 'NORMAL_MAP';

ALTER TYPE "AssetStatus" ADD VALUE IF NOT EXISTS 'VERIFYING' AFTER 'PENDING_UPLOAD';
ALTER TYPE "AssetStatus" ADD VALUE IF NOT EXISTS 'REJECTED' AFTER 'READY';

-- Add nullable lifecycle fields so existing Asset rows remain valid.
ALTER TABLE "Asset"
  ADD COLUMN "uploadRequestId" VARCHAR(160),
  ADD COLUMN "uploadExpiresAt" TIMESTAMP(3),
  ADD COLUMN "verificationStartedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionCode" VARCHAR(128),
  ADD COLUMN "verificationAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Asset_ownerId_uploadRequestId_key"
  ON "Asset"("ownerId", "uploadRequestId");

CREATE INDEX "Asset_ownerId_status_uploadExpiresAt_idx"
  ON "Asset"("ownerId", "status", "uploadExpiresAt");
