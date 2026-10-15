import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(new URL("../prisma/migrations/20261015000200_phase_2e_render_jobs_workflows/migration.sql", import.meta.url)), "utf8");
const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");

describe("Milestone 2E migration contract", () => {
  it("is a bounded operator-reviewed transaction", () => {
    expect(migration).toContain("OPERATOR CHECKPOINT");
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '5min';");
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });
  it("preserves immutable asset references with owner-scoped restrictive foreign keys", () => {
    for (const constraint of [
      "RenderJob_projectId_ownerId_fkey", "RenderJob_workflowVersionId_ownerId_fkey",
      "RenderJobInput_assetId_ownerId_fkey", "RenderJobInput_storageObjectId_assetId_ownerId_fkey",
      "RenderJobOutput_assetId_ownerId_fkey", "RenderJobEvent_jobId_ownerId_fkey",
      "WorkflowPreset_projectId_ownerId_fkey", "WorkflowVersion_presetId_ownerId_fkey",
    ]) expect(migration).toContain(constraint);
    expect(migration).toContain("2E migration blocked: cross-owner render/workflow references exist");
    expect(schema).toContain("storageObject AssetStorageObject");
    expect(schema).toContain("@@unique([id, assetId, ownerId])");
    expect(schema).toMatch(/workflowVersion\s+WorkflowVersion\?\s+@relation\(fields: \[workflowVersionId, ownerId\]/);
  });
  it("backfills workflow publication and stable input snapshots before enforcing shapes", () => {
    expect(migration).toContain('"status" = \'PUBLISHED\'');
    expect(migration).toContain("jsonb_agg(jsonb_build_object(");
    expect(migration).toContain("RenderJob_snapshot_shape_check");
    expect(migration).toContain("WorkflowPreset_draft_shape_check");
  });
  it("adds queue indexes, attempt fencing and bounded values", () => {
    for (const value of ["CLAIMED", "CANCEL_REQUESTED", "RETRY_SCHEDULED"]) expect(migration).toContain(`'${value}'`);
    expect(migration).toContain("RenderJob_status_nextAttemptAt_priority_createdAt_idx");
    expect(migration).toContain('RenderJob_priority_createdAt_id_idx" ON "RenderJob"("priority" DESC, "createdAt", "id")');
    expect(migration).toContain("RenderJobAttempt_lease_hash_check");
    expect(migration).toContain("RenderJob_retry_check");
  });
});
