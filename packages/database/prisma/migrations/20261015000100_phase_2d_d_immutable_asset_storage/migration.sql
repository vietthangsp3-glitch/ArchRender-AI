-- Milestone 2D-D review-only, backward-compatible migration.
-- OPERATOR CHECKPOINT: do not apply automatically, do not use db push/reset.
-- Application-level immutability only: this does not enable R2 Object Lock/WORM.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "AssetStorageLayout" AS ENUM (
  'LEGACY_SINGLE_OBJECT',
  'STAGED_IMMUTABLE_V1'
);

CREATE TYPE "AssetIntegrityStatus" AS ENUM (
  'PENDING',
  'VERIFIED_IMMUTABLE',
  'LEGACY_GUARDED',
  'FAILED'
);

CREATE TYPE "AssetStorageObjectRole" AS ENUM (
  'STAGING',
  'ORIGINAL',
  'THUMBNAIL_GRID',
  'THUMBNAIL_DETAIL'
);

CREATE TYPE "AssetStorageObjectState" AS ENUM (
  'RESERVED',
  'WRITTEN',
  'VERIFIED',
  'CLEANUP_PENDING',
  'DELETED',
  'FAILED'
);

-- Fail before the backfill if the deployed database has diverged from the
-- complete AssetStatus set known to this application version.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Asset"
    WHERE "status"::text NOT IN (
      'PENDING_UPLOAD',
      'VERIFYING',
      'READY',
      'REJECTED',
      'QUARANTINED',
      'DELETED'
    )
  ) THEN
    RAISE EXCEPTION 'Unsupported Asset.status value for immutable storage migration';
  END IF;
END
$$;

ALTER TABLE "Asset"
  ADD COLUMN "storageLayout" "AssetStorageLayout" NOT NULL DEFAULT 'LEGACY_SINGLE_OBJECT',
  -- Fail closed for every row created after this DDL. Only the verification
  -- transaction may promote an asset to VERIFIED_IMMUTABLE.
  ADD COLUMN "integrityStatus" "AssetIntegrityStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "finalizedAt" TIMESTAMP(3);

-- Every current AssetStatus is classified explicitly. Existing READY records
-- keep their current object identity under LEGACY_GUARDED; no R2 object or key
-- is created, moved, overwritten, or deleted by this migration.
UPDATE "Asset"
SET "integrityStatus" = CASE "status"
  WHEN 'PENDING_UPLOAD' THEN 'PENDING'::"AssetIntegrityStatus"
  WHEN 'VERIFYING' THEN 'PENDING'::"AssetIntegrityStatus"
  WHEN 'READY' THEN 'LEGACY_GUARDED'::"AssetIntegrityStatus"
  WHEN 'REJECTED' THEN 'FAILED'::"AssetIntegrityStatus"
  WHEN 'QUARANTINED' THEN 'FAILED'::"AssetIntegrityStatus"
  WHEN 'DELETED' THEN 'FAILED'::"AssetIntegrityStatus"
END;

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_checksumSha256_check"
    CHECK ("checksumSha256" IS NULL OR "checksumSha256" ~ '^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT "Asset_byteSize_check"
    CHECK ("byteSize" IS NULL OR "byteSize" > 0) NOT VALID,
  ADD CONSTRAINT "Asset_dimensions_check"
    CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)) NOT VALID,
  ADD CONSTRAINT "Asset_integrity_state_check"
    CHECK (
      ("integrityStatus" = 'PENDING' AND "status" IN ('PENDING_UPLOAD', 'VERIFYING', 'DELETED'))
      OR ("integrityStatus" = 'FAILED' AND "status" IN ('REJECTED', 'QUARANTINED', 'DELETED'))
      OR (
        "integrityStatus" = 'LEGACY_GUARDED'
        AND "storageLayout" = 'LEGACY_SINGLE_OBJECT'
        AND "status" IN ('READY', 'DELETED')
      )
      OR (
        "integrityStatus" = 'VERIFIED_IMMUTABLE'
        AND "storageLayout" = 'STAGED_IMMUTABLE_V1'
        AND "status" IN ('READY', 'DELETED')
        AND "finalizedAt" IS NOT NULL
        AND "verifiedAt" IS NOT NULL
        AND "checksumSha256" IS NOT NULL
        AND "byteSize" IS NOT NULL
        AND "contentType" IS NOT NULL
        AND "width" IS NOT NULL
        AND "height" IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_checksumSha256_check";
ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_byteSize_check";
ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_dimensions_check";
ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_integrity_state_check";

CREATE TABLE "AssetStorageObject" (
  "id" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "role" "AssetStorageObjectRole" NOT NULL,
  "state" "AssetStorageObjectState" NOT NULL DEFAULT 'RESERVED',
  "bucket" VARCHAR(128) NOT NULL,
  "objectKey" VARCHAR(1024) NOT NULL,
  "contentType" VARCHAR(255),
  "byteSize" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "checksumSha256" VARCHAR(64),
  "storageEtag" VARCHAR(512),
  "sourceObjectId" UUID,
  "uploadExpiresAt" TIMESTAMP(3),
  "immutableAt" TIMESTAMP(3),
  "cleanupAfter" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssetStorageObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssetStorageObject_nonempty_identity_check"
    CHECK (length(btrim("bucket")) > 0 AND length(btrim("objectKey")) > 0),
  CONSTRAINT "AssetStorageObject_checksumSha256_check"
    CHECK ("checksumSha256" IS NULL OR "checksumSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AssetStorageObject_byteSize_check"
    CHECK ("byteSize" IS NULL OR "byteSize" > 0),
  CONSTRAINT "AssetStorageObject_dimensions_check"
    CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
  CONSTRAINT "AssetStorageObject_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "AssetStorageObject_source_lineage_check"
    CHECK (
      ("role" IN ('STAGING', 'ORIGINAL') AND "sourceObjectId" IS NULL)
      OR ("role" IN ('THUMBNAIL_GRID', 'THUMBNAIL_DETAIL') AND "sourceObjectId" IS NOT NULL)
    ),
  CONSTRAINT "AssetStorageObject_upload_contract_check"
    CHECK ("role" = 'STAGING' OR "uploadExpiresAt" IS NULL),
  CONSTRAINT "AssetStorageObject_verified_identity_check"
    CHECK (
      "state" <> 'VERIFIED'
      OR (
        "role" IN ('ORIGINAL', 'THUMBNAIL_GRID', 'THUMBNAIL_DETAIL')
        AND "contentType" IS NOT NULL
        AND "byteSize" IS NOT NULL
        AND "width" IS NOT NULL
        AND "height" IS NOT NULL
        AND "checksumSha256" IS NOT NULL
        AND "storageEtag" IS NOT NULL
        AND length(btrim("storageEtag")) > 0
        AND "immutableAt" IS NOT NULL
      )
    ),
  CONSTRAINT "AssetStorageObject_deleted_tombstone_check"
    CHECK (
      ("state" = 'DELETED' AND "deletedAt" IS NOT NULL)
      OR ("state" <> 'DELETED' AND "deletedAt" IS NULL)
    )
);

-- One durable row per role is intentional: initiate reserves STAGING and
-- ORIGINAL once, retries reuse those rows, and concurrent completion converges
-- on the same ORIGINAL identity. A new upload attempt receives a new Asset id.
CREATE UNIQUE INDEX "AssetStorageObject_assetId_role_key"
  ON "AssetStorageObject"("assetId", "role");
CREATE UNIQUE INDEX "AssetStorageObject_bucket_objectKey_key"
  ON "AssetStorageObject"("bucket", "objectKey");
CREATE UNIQUE INDEX "AssetStorageObject_id_ownerId_key"
  ON "AssetStorageObject"("id", "ownerId");
CREATE UNIQUE INDEX "AssetStorageObject_id_assetId_ownerId_key"
  ON "AssetStorageObject"("id", "assetId", "ownerId");
CREATE INDEX "AssetStorageObject_ownerId_state_cleanupAfter_idx"
  ON "AssetStorageObject"("ownerId", "state", "cleanupAfter");
CREATE INDEX "AssetStorageObject_assetId_state_idx"
  ON "AssetStorageObject"("assetId", "state");
CREATE INDEX "AssetStorageObject_sourceObjectId_idx"
  ON "AssetStorageObject"("sourceObjectId");

-- Metadata is retained as a tombstone until the object lifecycle is reconciled.
-- Deleting an Asset first is blocked so it cannot hide a still-live R2 object.
ALTER TABLE "AssetStorageObject"
  ADD CONSTRAINT "AssetStorageObject_assetId_ownerId_fkey"
  FOREIGN KEY ("assetId", "ownerId") REFERENCES "Asset"("id", "ownerId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lineage cannot silently disappear. Including assetId and ownerId in the FK
-- also prevents a derivative from naming a source owned by another asset/user.
ALTER TABLE "AssetStorageObject"
  ADD CONSTRAINT "AssetStorageObject_sourceObjectId_assetId_ownerId_fkey"
  FOREIGN KEY ("sourceObjectId", "assetId", "ownerId")
  REFERENCES "AssetStorageObject"("id", "assetId", "ownerId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
