import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, Prisma } from "@archrender/database";
import { JobApplicationError, RenderJobService, WorkerQueueService, WorkflowService } from "../../src/index.js";
import { createVerifiedImmutableAssetFixture } from "./fixtures.js";

const database = createDatabaseClient();
const jobs = new RenderJobService(database);
const workflows = new WorkflowService(database);
const queue = new WorkerQueueService(database);
const run = `m2e-${Date.now()}-${randomUUID()}`;
const ownerIds: string[] = [];
let ownerA: { id: string; role: "OWNER" };
let ownerB: { id: string; role: "OWNER" };
let projectId = "";
let assetId = "";
let ownerBAssetId = "";
let ownerBStorageObjectId = "";
let workflowVersionId = "";
let jobId = "";

async function cleanup() {
  if (!ownerIds.length) return;
  const [jobRows, versionRows, presetRows, objectRows, assetRows, projectRows] = await Promise.all([
    database.renderJob.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } }),
    database.workflowVersion.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } }),
    database.workflowPreset.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } }),
    database.assetStorageObject.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } }),
    database.asset.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } }),
    database.project.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } }),
  ]);
  await database.$transaction(async (tx) => {
    await tx.renderJob.deleteMany({ where: { id: { in: jobRows.map(({ id }) => id) } } });
    await tx.workflowVersion.deleteMany({ where: { id: { in: versionRows.map(({ id }) => id) } } });
    await tx.workflowPreset.deleteMany({ where: { id: { in: presetRows.map(({ id }) => id) } } });
    await tx.assetStorageObject.deleteMany({ where: { id: { in: objectRows.map(({ id }) => id) } } });
    await tx.asset.deleteMany({ where: { id: { in: assetRows.map(({ id }) => id) } } });
    await tx.project.deleteMany({ where: { id: { in: projectRows.map(({ id }) => id) } } });
    await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
  });
  const remaining = await database.user.count({ where: { id: { in: ownerIds } } });
  if (remaining !== 0) throw new Error("M2E_FIXTURE_CLEANUP_INCOMPLETE");
}

beforeAll(async () => {
  const migration = await database.$queryRaw<Array<{ migration_name: string }>>(Prisma.sql`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = '20261015000200_phase_2e_render_jobs_workflows' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  expect(migration).toHaveLength(1);
  const [a, b] = await database.$transaction([
    database.user.create({ data: { email: `${run}-a@integration.invalid`, passwordHash: "synthetic-not-a-password", displayName: run, role: "OWNER" } }),
    database.user.create({ data: { email: `${run}-b@integration.invalid`, passwordHash: "synthetic-not-a-password", displayName: run, role: "OWNER" } }),
  ]);
  ownerIds.push(a.id, b.id); ownerA = { id: a.id, role: "OWNER" }; ownerB = { id: b.id, role: "OWNER" };
  const [project, projectB] = await database.$transaction([
    database.project.create({ data: { ownerId: a.id, name: run, slug: run, type: "MIXED", status: "ACTIVE" } }),
    database.project.create({ data: { ownerId: b.id, name: `${run}-b`, slug: `${run}-b`, type: "MIXED", status: "ACTIVE" } }),
  ]);
  projectId = project.id;
  const [assetA, assetB] = await Promise.all([
    createVerifiedImmutableAssetFixture(database, { ownerId: a.id, projectId, runId: run, checksumCharacter: "a" }),
    createVerifiedImmutableAssetFixture(database, { ownerId: b.id, projectId: projectB.id, runId: run, checksumCharacter: "c" }),
  ]);
  assetId = assetA.asset.id;
  ownerBAssetId = assetB.asset.id;
  ownerBStorageObjectId = assetB.storageObject.id;
  const workflow = await workflows.create(ownerA, { name: run, kind: "IMAGE_RENDER", configuration: { backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1", modelFamily: "integration", conditioning: ["IMAGE"] } });
  workflowVersionId = (await workflows.publish(ownerA, workflow.id)).id;
});

afterAll(async () => { try { await cleanup(); } finally { await database.$disconnect(); } });

describe.sequential("Milestone 2E PostgreSQL acceptance", () => {
  it("creates an immutable snapshot idempotently and isolates owners", async () => {
    const input = { idempotencyKey: `${run}-request`, projectId, workflowVersionId, type: "IMAGE_RENDER" as const, inputs: [{ assetId, role: "SOURCE_IMAGE" as const, position: 0 }], parameters: { prompt: "synthetic house", width: 1024, height: 768 } };
    const first = await jobs.submit(ownerA, input);
    const replay = await jobs.submit(ownerA, input);
    jobId = first.id;
    expect(replay.id).toBe(first.id);
    await expect(jobs.submit(ownerA, { ...input, parameters: { ...input.parameters, prompt: "different" } })).rejects.toMatchObject({ code: "JOB_IDEMPOTENCY_CONFLICT" });
    await expect(jobs.get(ownerB, first.id)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(jobs.submit(ownerA, { ...input, idempotencyKey: `${run}-cross-owner`, inputs: [{ assetId: ownerBAssetId, role: "SOURCE_IMAGE", position: 0 }] })).rejects.toMatchObject({ code: "JOB_ASSET_INVALID" });
    await expect(database.renderJobInput.create({ data: { jobId: first.id, ownerId: ownerA.id, assetId: ownerBAssetId, storageObjectId: ownerBStorageObjectId, checksumSha256: "c".repeat(64), storageEtag: `"${"b".repeat(32)}"`, contentType: "image/png", role: "CONTROL_IMAGE", position: 1 } })).rejects.toBeTruthy();
    const stored = await database.renderJob.findUniqueOrThrow({ where: { id: first.id }, include: { inputs: true } });
    expect(stored.inputs[0]?.checksumSha256).toBe("a".repeat(64));
    await expect(database.asset.delete({ where: { id: assetId } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects an impossible VERIFIED_IMMUTABLE asset state", async () => {
    const objectKey = `m2e/${run}/invalid-missing-dimensions.png`;
    await expect(database.asset.create({ data: { ownerId: ownerA.id, projectId, type: "SOURCE_IMAGE", status: "READY", bucket: "archrender-integration-fixtures", objectKey, contentType: "image/png", byteSize: 68n, checksumSha256: "d".repeat(64), storageLayout: "STAGED_IMMUTABLE_V1", integrityStatus: "VERIFIED_IMMUTABLE", verifiedAt: new Date(), finalizedAt: new Date() } })).rejects.toBeTruthy();
    expect(await database.asset.count({ where: { bucket: "archrender-integration-fixtures", objectKey } })).toBe(0);
  });

  it("atomically claims once and fences a worker after lease recovery", async () => {
    const [left, right] = await Promise.all([queue.claim("integration-worker-a", 15), queue.claim("integration-worker-b", 15)]);
    const claims = [left, right].filter((value) => value !== null);
    expect(claims).toHaveLength(1);
    const stale = claims[0]!;
    await queue.start(stale);
    await database.renderJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(0) } });
    expect(await queue.recoverExpired(1)).toBe(1);
    await database.renderJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date(0) } });
    const replacement = await queue.claim("integration-worker-c", 60);
    expect(replacement?.generation).toBeGreaterThan(stale.generation);
    await expect(queue.succeed(stale)).rejects.toBeInstanceOf(JobApplicationError);
    await queue.start(replacement!);
    await queue.succeed(replacement!);
    expect((await database.renderJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("SUCCEEDED");
  });

  it("keeps event sequence ordered and lease hashes private", async () => {
    const detail = await jobs.get(ownerA, jobId);
    expect(detail.events.map((event) => event.sequence)).toEqual([...detail.events.map((event) => event.sequence)].sort((a, b) => a - b));
    expect(JSON.stringify(detail)).not.toContain("leaseTokenHash");
  });
});
