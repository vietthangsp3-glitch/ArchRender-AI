-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('INTERIOR', 'EXTERIOR', 'MIXED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('SOURCE_RENDER', 'DEPTH_MAP', 'NORMAL_MAP', 'GENERATED_IMAGE', 'GENERATED_VIDEO', 'WORKFLOW_FILE');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'QUARANTINED', 'DELETED');

-- CreateEnum
CREATE TYPE "RenderJobType" AS ENUM ('IMAGE_RENDER', 'IMAGE_UPSCALE', 'IMAGE_TO_VIDEO');

-- CreateEnum
CREATE TYPE "RenderJobStatus" AS ENUM ('CREATED', 'UPLOADING', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RenderJobEventType" AS ENUM ('STATUS_CHANGED', 'PROGRESS', 'LOG', 'OUTPUT_ATTACHED', 'COST_UPDATED', 'ERROR');

-- CreateEnum
CREATE TYPE "WorkflowKind" AS ENUM ('IMAGE_RENDER', 'IMAGE_UPSCALE', 'IMAGE_TO_VIDEO');

-- CreateEnum
CREATE TYPE "GPUProvider" AS ENUM ('VAST_AI', 'RUNPOD');

-- CreateEnum
CREATE TYPE "GPUAllocationStatus" AS ENUM ('REQUESTED', 'PROVISIONING', 'READY', 'BUSY', 'STOPPED', 'TERMINATED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(160),
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "userAgent" VARCHAR(512),
    "ipHash" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "slug" VARCHAR(180) NOT NULL,
    "description" TEXT,
    "type" "ProjectType" NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "projectId" UUID,
    "type" "AssetType" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "bucket" VARCHAR(128) NOT NULL,
    "objectKey" VARCHAR(1024) NOT NULL,
    "originalName" VARCHAR(512),
    "contentType" VARCHAR(255),
    "byteSize" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "checksumSha256" VARCHAR(64),
    "metadata" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowVersionId" UUID,
    "type" "RenderJobType" NOT NULL,
    "status" "RenderJobStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "parameters" JSONB NOT NULL,
    "requestedWidth" INTEGER,
    "requestedHeight" INTEGER,
    "requestedResolution" VARCHAR(32),
    "estimatedCost" DECIMAL(14,6),
    "actualCost" DECIMAL(14,6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "errorCode" VARCHAR(128),
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderJobInput" (
    "jobId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderJobInput_pkey" PRIMARY KEY ("jobId","assetId")
);

-- CreateTable
CREATE TABLE "RenderJobOutput" (
    "jobId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderJobOutput_pkey" PRIMARY KEY ("jobId","assetId")
);

-- CreateTable
CREATE TABLE "RenderJobEvent" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "RenderJobEventType" NOT NULL,
    "fromStatus" "RenderJobStatus",
    "toStatus" "RenderJobStatus",
    "progress" DECIMAL(5,2),
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowPreset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "projectId" UUID,
    "name" VARCHAR(180) NOT NULL,
    "description" TEXT,
    "kind" "WorkflowKind" NOT NULL,
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "presetId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "parameterSchemaVersion" VARCHAR(32) NOT NULL,
    "workflowReference" VARCHAR(1024) NOT NULL,
    "parameters" JSONB NOT NULL,
    "semanticMapping" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GPUAllocation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "jobId" UUID,
    "provider" "GPUProvider" NOT NULL,
    "providerAllocationId" VARCHAR(255),
    "status" "GPUAllocationStatus" NOT NULL DEFAULT 'REQUESTED',
    "gpuModel" VARCHAR(255),
    "vramMb" INTEGER,
    "hourlyRate" DECIMAL(14,6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "provisionedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GPUAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderUsageRecord" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "jobId" UUID,
    "gpuAllocationId" UUID,
    "provider" "GPUProvider" NOT NULL,
    "externalResourceId" VARCHAR(255),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "billedSeconds" INTEGER,
    "hourlyRate" DECIMAL(14,6),
    "estimatedCost" DECIMAL(14,6),
    "actualCost" DECIMAL(14,6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "rawUsage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "actorUserId" UUID,
    "action" VARCHAR(160) NOT NULL,
    "entityType" VARCHAR(80) NOT NULL,
    "entityId" VARCHAR(255),
    "requestId" VARCHAR(160),
    "ipHash" VARCHAR(128),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_disabledAt_idx" ON "User"("disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Project_ownerId_status_updatedAt_idx" ON "Project"("ownerId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_ownerId_slug_key" ON "Project"("ownerId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_id_ownerId_key" ON "Project"("id", "ownerId");

-- CreateIndex
CREATE INDEX "Asset_ownerId_projectId_type_createdAt_idx" ON "Asset"("ownerId", "projectId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_ownerId_status_idx" ON "Asset"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Asset_checksumSha256_idx" ON "Asset"("checksumSha256");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_id_ownerId_key" ON "Asset"("id", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_bucket_objectKey_key" ON "Asset"("bucket", "objectKey");

-- CreateIndex
CREATE INDEX "RenderJob_ownerId_projectId_createdAt_idx" ON "RenderJob"("ownerId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJob_ownerId_status_createdAt_idx" ON "RenderJob"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJob_workflowVersionId_idx" ON "RenderJob"("workflowVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_ownerId_idempotencyKey_key" ON "RenderJob"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_id_ownerId_key" ON "RenderJob"("id", "ownerId");

-- CreateIndex
CREATE INDEX "RenderJobInput_assetId_idx" ON "RenderJobInput"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJobInput_jobId_role_position_key" ON "RenderJobInput"("jobId", "role", "position");

-- CreateIndex
CREATE INDEX "RenderJobOutput_assetId_idx" ON "RenderJobOutput"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJobOutput_jobId_role_position_key" ON "RenderJobOutput"("jobId", "role", "position");

-- CreateIndex
CREATE INDEX "RenderJobEvent_ownerId_createdAt_idx" ON "RenderJobEvent"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJobEvent_jobId_createdAt_idx" ON "RenderJobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJobEvent_jobId_sequence_key" ON "RenderJobEvent"("jobId", "sequence");

-- CreateIndex
CREATE INDEX "WorkflowPreset_ownerId_kind_updatedAt_idx" ON "WorkflowPreset"("ownerId", "kind", "updatedAt");

-- CreateIndex
CREATE INDEX "WorkflowPreset_projectId_idx" ON "WorkflowPreset"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowPreset_ownerId_name_key" ON "WorkflowPreset"("ownerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowPreset_id_ownerId_key" ON "WorkflowPreset"("id", "ownerId");

-- CreateIndex
CREATE INDEX "WorkflowVersion_ownerId_createdAt_idx" ON "WorkflowVersion"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_presetId_version_key" ON "WorkflowVersion"("presetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_id_ownerId_key" ON "WorkflowVersion"("id", "ownerId");

-- CreateIndex
CREATE INDEX "GPUAllocation_ownerId_status_createdAt_idx" ON "GPUAllocation"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "GPUAllocation_jobId_idx" ON "GPUAllocation"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "GPUAllocation_provider_providerAllocationId_key" ON "GPUAllocation"("provider", "providerAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "GPUAllocation_id_ownerId_key" ON "GPUAllocation"("id", "ownerId");

-- CreateIndex
CREATE INDEX "ProviderUsageRecord_ownerId_startedAt_idx" ON "ProviderUsageRecord"("ownerId", "startedAt");

-- CreateIndex
CREATE INDEX "ProviderUsageRecord_jobId_idx" ON "ProviderUsageRecord"("jobId");

-- CreateIndex
CREATE INDEX "ProviderUsageRecord_gpuAllocationId_idx" ON "ProviderUsageRecord"("gpuAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderUsageRecord_provider_externalResourceId_key" ON "ProviderUsageRecord"("provider", "externalResourceId");

-- CreateIndex
CREATE INDEX "ActivityLog_ownerId_createdAt_idx" ON "ActivityLog"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_ownerId_entityType_entityId_idx" ON "ActivityLog"("ownerId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "ActivityLog_requestId_idx" ON "ActivityLog"("requestId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJobInput" ADD CONSTRAINT "RenderJobInput_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJobInput" ADD CONSTRAINT "RenderJobInput_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJobOutput" ADD CONSTRAINT "RenderJobOutput_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJobOutput" ADD CONSTRAINT "RenderJobOutput_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJobEvent" ADD CONSTRAINT "RenderJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJobEvent" ADD CONSTRAINT "RenderJobEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowPreset" ADD CONSTRAINT "WorkflowPreset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowPreset" ADD CONSTRAINT "WorkflowPreset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "WorkflowPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GPUAllocation" ADD CONSTRAINT "GPUAllocation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GPUAllocation" ADD CONSTRAINT "GPUAllocation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderUsageRecord" ADD CONSTRAINT "ProviderUsageRecord_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderUsageRecord" ADD CONSTRAINT "ProviderUsageRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderUsageRecord" ADD CONSTRAINT "ProviderUsageRecord_gpuAllocationId_fkey" FOREIGN KEY ("gpuAllocationId") REFERENCES "GPUAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
