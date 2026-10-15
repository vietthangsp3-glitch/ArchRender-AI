-- Milestone 2E: durable render jobs and immutable workflow versions.
-- Review-only: operator must inspect and apply this migration explicitly.
-- OPERATOR CHECKPOINT: do not apply until the owner has reviewed this file.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TYPE "RenderJobStatus" ADD VALUE IF NOT EXISTS 'CLAIMED';
ALTER TYPE "RenderJobStatus" ADD VALUE IF NOT EXISTS 'CANCEL_REQUESTED';
ALTER TYPE "RenderJobStatus" ADD VALUE IF NOT EXISTS 'RETRY_SCHEDULED';

CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "RenderJobAttemptStatus" AS ENUM ('CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'LEASE_EXPIRED');

ALTER TABLE "RenderJob"
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "progress" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "inputSnapshot" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxRetries" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "leaseOwner" VARCHAR(160),
  ADD COLUMN "leaseTokenHash" VARCHAR(128),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "executionGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "WorkflowPreset"
  ADD COLUMN "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "draftConfiguration" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "parameterSchemaVersion" VARCHAR(32) NOT NULL DEFAULT '1';

WITH latest AS (
  SELECT DISTINCT ON ("presetId")
    "presetId", "parameters", "parameterSchemaVersion", "version"
  FROM "WorkflowVersion"
  ORDER BY "presetId", "version" DESC
)
UPDATE "WorkflowPreset" AS preset
SET "draftConfiguration" = latest."parameters",
    "parameterSchemaVersion" = latest."parameterSchemaVersion",
    "status" = 'PUBLISHED',
    "currentVersionNumber" = latest."version"
FROM latest
WHERE latest."presetId" = preset."id";

ALTER TABLE "WorkflowVersion"
  ADD COLUMN "compatibility" JSONB,
  ADD COLUMN "publishedAt" TIMESTAMP(3);

UPDATE "WorkflowVersion" SET "publishedAt" = "createdAt";
ALTER TABLE "WorkflowVersion"
  ALTER COLUMN "publishedAt" SET NOT NULL,
  ALTER COLUMN "publishedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "RenderJobInput"
  ADD COLUMN "ownerId" UUID,
  ADD COLUMN "storageObjectId" UUID,
  ADD COLUMN "checksumSha256" VARCHAR(64),
  ADD COLUMN "storageEtag" VARCHAR(512),
  ADD COLUMN "contentType" VARCHAR(255);

ALTER TABLE "RenderJobOutput" ADD COLUMN "ownerId" UUID;

UPDATE "RenderJobOutput" AS output
SET "ownerId" = job."ownerId"
FROM "RenderJob" AS job
WHERE output."jobId" = job."id";

UPDATE "RenderJobInput" AS input
SET "ownerId" = job."ownerId",
    "storageObjectId" = object."id",
    "checksumSha256" = object."checksumSha256",
    "storageEtag" = object."storageEtag",
    "contentType" = object."contentType"
FROM "RenderJob" AS job,
     "AssetStorageObject" AS object
WHERE input."jobId" = job."id"
  AND input."assetId" = object."assetId"
  AND object."ownerId" = job."ownerId"
  AND object."role" = 'ORIGINAL'
  AND object."state" = 'VERIFIED'
  AND object."deletedAt" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "RenderJobInput"
    WHERE "ownerId" IS NULL OR "storageObjectId" IS NULL OR
          "checksumSha256" IS NULL OR "storageEtag" IS NULL OR "contentType" IS NULL
  ) THEN
    RAISE EXCEPTION '2E migration blocked: an existing RenderJobInput lacks a verified immutable ORIGINAL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "RenderJob" job JOIN "Project" project ON project."id" = job."projectId"
    WHERE job."ownerId" <> project."ownerId"
  ) OR EXISTS (
    SELECT 1 FROM "RenderJob" job JOIN "WorkflowVersion" version ON version."id" = job."workflowVersionId"
    WHERE job."ownerId" <> version."ownerId"
  ) OR EXISTS (
    SELECT 1 FROM "RenderJobEvent" event JOIN "RenderJob" job ON job."id" = event."jobId"
    WHERE event."ownerId" <> job."ownerId"
  ) OR EXISTS (
    SELECT 1 FROM "RenderJobOutput" output
    JOIN "RenderJob" job ON job."id" = output."jobId"
    JOIN "Asset" asset ON asset."id" = output."assetId"
    WHERE output."ownerId" IS NULL OR output."ownerId" <> asset."ownerId" OR output."ownerId" <> job."ownerId"
  ) OR EXISTS (
    SELECT 1 FROM "WorkflowPreset" preset JOIN "Project" project ON project."id" = preset."projectId"
    WHERE preset."ownerId" <> project."ownerId"
  ) OR EXISTS (
    SELECT 1 FROM "WorkflowVersion" version JOIN "WorkflowPreset" preset ON preset."id" = version."presetId"
    WHERE version."ownerId" <> preset."ownerId"
  ) THEN
    RAISE EXCEPTION '2E migration blocked: cross-owner render/workflow references exist';
  END IF;
END $$;

WITH snapshots AS (
  SELECT input."jobId", jsonb_agg(jsonb_build_object(
    'assetId', input."assetId",
    'role', input."role",
    'position', input."position",
    'storageObjectId', input."storageObjectId",
    'checksumSha256', input."checksumSha256",
    'storageEtag', input."storageEtag",
    'contentType', input."contentType"
  ) ORDER BY input."position", input."assetId") AS snapshot
  FROM "RenderJobInput" AS input
  GROUP BY input."jobId"
)
UPDATE "RenderJob" AS job
SET "inputSnapshot" = snapshots.snapshot
FROM snapshots
WHERE snapshots."jobId" = job."id";

ALTER TABLE "RenderJobInput"
  ALTER COLUMN "ownerId" SET NOT NULL,
  ALTER COLUMN "storageObjectId" SET NOT NULL,
  ALTER COLUMN "checksumSha256" SET NOT NULL,
  ALTER COLUMN "storageEtag" SET NOT NULL,
  ALTER COLUMN "contentType" SET NOT NULL;

ALTER TABLE "RenderJobOutput" ALTER COLUMN "ownerId" SET NOT NULL;

ALTER TABLE "RenderJob" DROP CONSTRAINT "RenderJob_projectId_fkey";
ALTER TABLE "RenderJob" DROP CONSTRAINT "RenderJob_workflowVersionId_fkey";
ALTER TABLE "RenderJob"
  ADD CONSTRAINT "RenderJob_projectId_ownerId_fkey"
  FOREIGN KEY ("projectId", "ownerId") REFERENCES "Project"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "RenderJob_workflowVersionId_ownerId_fkey"
  FOREIGN KEY ("workflowVersionId", "ownerId") REFERENCES "WorkflowVersion"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RenderJobInput" DROP CONSTRAINT "RenderJobInput_jobId_fkey";
ALTER TABLE "RenderJobInput" DROP CONSTRAINT "RenderJobInput_assetId_fkey";
ALTER TABLE "RenderJobInput"
  ADD CONSTRAINT "RenderJobInput_jobId_ownerId_fkey"
  FOREIGN KEY ("jobId", "ownerId") REFERENCES "RenderJob"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RenderJobInput_assetId_ownerId_fkey"
  FOREIGN KEY ("assetId", "ownerId") REFERENCES "Asset"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "RenderJobInput_storageObjectId_assetId_ownerId_fkey"
  FOREIGN KEY ("storageObjectId", "assetId", "ownerId") REFERENCES "AssetStorageObject"("id", "assetId", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RenderJobOutput" DROP CONSTRAINT "RenderJobOutput_jobId_fkey";
ALTER TABLE "RenderJobOutput" DROP CONSTRAINT "RenderJobOutput_assetId_fkey";
ALTER TABLE "RenderJobOutput"
  ADD CONSTRAINT "RenderJobOutput_jobId_ownerId_fkey"
  FOREIGN KEY ("jobId", "ownerId") REFERENCES "RenderJob"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RenderJobOutput_assetId_ownerId_fkey"
  FOREIGN KEY ("assetId", "ownerId") REFERENCES "Asset"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RenderJobEvent" DROP CONSTRAINT "RenderJobEvent_jobId_fkey";
ALTER TABLE "RenderJobEvent"
  ADD CONSTRAINT "RenderJobEvent_jobId_ownerId_fkey"
  FOREIGN KEY ("jobId", "ownerId") REFERENCES "RenderJob"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowPreset" DROP CONSTRAINT "WorkflowPreset_projectId_fkey";
ALTER TABLE "WorkflowPreset"
  ADD CONSTRAINT "WorkflowPreset_projectId_ownerId_fkey"
  FOREIGN KEY ("projectId", "ownerId") REFERENCES "Project"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkflowVersion" DROP CONSTRAINT "WorkflowVersion_presetId_fkey";
ALTER TABLE "WorkflowVersion"
  ADD CONSTRAINT "WorkflowVersion_presetId_ownerId_fkey"
  FOREIGN KEY ("presetId", "ownerId") REFERENCES "WorkflowPreset"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RenderJobAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "jobId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL,
  "workerId" VARCHAR(160) NOT NULL,
  "leaseTokenHash" VARCHAR(128) NOT NULL,
  "status" "RenderJobAttemptStatus" NOT NULL DEFAULT 'CLAIMED',
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "errorCode" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RenderJobAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RenderJobAttempt_jobId_ownerId_fkey"
    FOREIGN KEY ("jobId", "ownerId") REFERENCES "RenderJob"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RenderJobAttempt_jobId_attemptNumber_key" ON "RenderJobAttempt"("jobId", "attemptNumber");
CREATE UNIQUE INDEX "RenderJobAttempt_jobId_generation_key" ON "RenderJobAttempt"("jobId", "generation");
CREATE INDEX "RenderJobAttempt_ownerId_createdAt_idx" ON "RenderJobAttempt"("ownerId", "createdAt");
CREATE INDEX "RenderJobAttempt_status_leaseExpiresAt_idx" ON "RenderJobAttempt"("status", "leaseExpiresAt");
CREATE INDEX "RenderJob_status_nextAttemptAt_priority_createdAt_idx" ON "RenderJob"("status", "nextAttemptAt", "priority", "createdAt");
CREATE INDEX "RenderJob_priority_createdAt_id_idx" ON "RenderJob"("priority" DESC, "createdAt", "id");
CREATE INDEX "RenderJob_status_leaseExpiresAt_idx" ON "RenderJob"("status", "leaseExpiresAt");
CREATE INDEX "RenderJobInput_ownerId_assetId_idx" ON "RenderJobInput"("ownerId", "assetId");
CREATE INDEX "RenderJobInput_storageObjectId_idx" ON "RenderJobInput"("storageObjectId");
CREATE INDEX "RenderJobOutput_ownerId_assetId_idx" ON "RenderJobOutput"("ownerId", "assetId");

ALTER TABLE "RenderJob"
  ADD CONSTRAINT "RenderJob_progress_check" CHECK ("progress" >= 0 AND "progress" <= 100),
  ADD CONSTRAINT "RenderJob_priority_check" CHECK ("priority" >= -10 AND "priority" <= 10),
  ADD CONSTRAINT "RenderJob_retry_check" CHECK ("retryCount" >= 0 AND "maxRetries" BETWEEN 0 AND 10 AND "retryCount" <= "maxRetries"),
  ADD CONSTRAINT "RenderJob_generation_check" CHECK ("executionGeneration" >= 0),
  ADD CONSTRAINT "RenderJob_snapshot_shape_check" CHECK (jsonb_typeof("inputSnapshot") = 'array'),
  ADD CONSTRAINT "RenderJob_parameters_shape_check" CHECK (jsonb_typeof("parameters") = 'object'),
  ADD CONSTRAINT "RenderJob_lease_identity_check" CHECK (
    ("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL) OR
    ("leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  );

ALTER TABLE "RenderJobInput"
  ADD CONSTRAINT "RenderJobInput_position_check" CHECK ("position" >= 0 AND "position" <= 32),
  ADD CONSTRAINT "RenderJobInput_checksum_check" CHECK ("checksumSha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "RenderJobAttempt"
  ADD CONSTRAINT "RenderJobAttempt_number_check" CHECK ("attemptNumber" > 0 AND "generation" > 0),
  ADD CONSTRAINT "RenderJobAttempt_lease_hash_check" CHECK ("leaseTokenHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "WorkflowPreset"
  ADD CONSTRAINT "WorkflowPreset_draft_shape_check" CHECK (jsonb_typeof("draftConfiguration") = 'object');

ALTER TABLE "WorkflowVersion"
  ADD CONSTRAINT "WorkflowVersion_parameters_shape_check" CHECK (jsonb_typeof("parameters") = 'object'),
  ADD CONSTRAINT "WorkflowVersion_compatibility_shape_check" CHECK ("compatibility" IS NULL OR jsonb_typeof("compatibility") = 'object');

ALTER TABLE "RenderJob" ALTER COLUMN "inputSnapshot" DROP DEFAULT;
ALTER TABLE "WorkflowPreset" ALTER COLUMN "draftConfiguration" DROP DEFAULT;

COMMIT;
