import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import { AssetRepository, createDatabaseClient, Prisma } from "@archrender/database";

import { AssetMaintenanceService } from "../../src/asset-maintenance-service.js";
import { AssetService } from "../../src/asset-service.js";
import type { AssetStorageConfig } from "../../src/config.js";
import { StorageError } from "../../src/errors.js";
import type {
  BoundedObjectContent,
  CreateImmutableObjectInput,
  CreatePresignedUploadInput,
  PresignedUploadRequest,
  StorageProvider,
  StoredObjectMetadata,
} from "../../src/storage-provider.js";
import type { StorageObjectKey } from "../../src/types.js";

type FakeObject = StoredObjectMetadata & { bytes: Uint8Array };

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, FakeObject>();
  readonly transientHeadFailures = new Set<string>();
  readonly readKeys: string[] = [];
  readCalls = 0;
  deleteCalls = 0;

  async createPresignedUpload(input: CreatePresignedUploadInput): Promise<PresignedUploadRequest> {
    return {
      method: "PUT",
      url: "https://signed.invalid/upload",
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000),
      requiredHeaders: {
        "content-type": input.contentType,
        "content-length": String(input.contentLength),
        "x-amz-meta-assetid": input.metadata["assetId"] ?? "",
      },
    };
  }

  async createPresignedReadUrl(): Promise<string> {
    return "https://signed.invalid/read";
  }

  async createImmutableObject(input: CreateImmutableObjectInput): Promise<StoredObjectMetadata> {
    if (this.objects.has(input.key)) {
      throw new StorageError("PRECONDITION_FAILED", "createImmutableObject", false);
    }
    const object = {
      bytes: input.bytes,
      contentLength: input.bytes.byteLength,
      contentType: input.contentType,
      etag: `"${createHash("md5").update(input.bytes).digest("hex")}"`,
      metadata: input.metadata,
    };
    this.objects.set(input.key, object);
    return object;
  }

  async headObject(key: StorageObjectKey): Promise<StoredObjectMetadata> {
    if (this.transientHeadFailures.delete(key)) {
      throw new StorageError("UNAVAILABLE", "headObject", true);
    }
    const object = this.objects.get(key);
    if (!object) throw new StorageError("NOT_FOUND", "headObject", false);
    return object;
  }

  async readObject(key: StorageObjectKey, maxBytes: number): Promise<BoundedObjectContent> {
    this.readCalls += 1;
    this.readKeys.push(key);
    const object = this.objects.get(key);
    if (!object) throw new StorageError("NOT_FOUND", "readObject", false);
    if (object.bytes.byteLength > maxBytes) throw new StorageError("INVALID_RESPONSE", "readObject", false);
    return object;
  }

  async deleteObject(key: StorageObjectKey): Promise<void> {
    this.deleteCalls += 1;
    this.objects.delete(key);
  }

  async objectExists(key: StorageObjectKey): Promise<boolean> {
    return this.objects.has(key);
  }
}

const database = createDatabaseClient();
const storage = new FakeStorageProvider();
const config: AssetStorageConfig = {
  accountId: "integration",
  bucket: "integration-private-assets",
  endpoint: "https://integration.r2.cloudflarestorage.com",
  credentials: { accessKeyId: "integration", secretAccessKey: "integration" },
  environment: "development",
  maxUploadBytes: 25 * 1024 * 1024,
  maxImageDimension: 16_384,
  maxDecodedPixels: 100_000_000,
  signedUrlTtlSeconds: 300,
  initiateRatePerMinute: 100,
  maxConcurrentUploads: 50,
  ownerQuotaBytes: 1024 ** 3,
  verificationStaleSeconds: 600,
  maxVerificationAttempts: 3,
  maxConcurrentVerifications: 2,
};
const service = new AssetService(database, storage, config);
const runId = `m2db-${Date.now()}-${randomUUID()}`;
const userIds: string[] = [];
const projectIds: string[] = [];
const assetIds: string[] = [];
const renderJobIds: string[] = [];
const stagingKeys = new Map<string, string>();
let ownerA = { id: "", role: "OWNER" as const };
let ownerB = { id: "", role: "OWNER" as const };
let projectA = "";

async function prepare(bytes: Uint8Array, name = "source.png") {
  const requestId = randomUUID();
  const prepared = await service.prepareUpload(ownerA, {
    requestId,
    projectId: projectA,
    assetType: "SOURCE_IMAGE",
    originalName: name,
    contentType: "image/png",
    byteSize: bytes.byteLength,
  });
  assetIds.push(prepared.assetId);
  const asset = await database.asset.findUniqueOrThrow({ where: { id: prepared.assetId } });
  const staging = await database.assetStorageObject.findFirstOrThrow({
    where: { assetId: asset.id, ownerId: ownerA.id, role: "STAGING" },
  });
  stagingKeys.set(asset.id, staging.objectKey);
  storage.objects.set(staging.objectKey, {
    bytes,
    contentLength: bytes.byteLength,
    contentType: "image/png",
    etag: `"etag-${asset.id}"`,
    metadata: { assetid: asset.id },
  });
  return asset;
}

beforeAll(async () => {
  const migration = await database.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"
      WHERE migration_name = '20261014000300_phase_2d_a_storage_foundation'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  expect(migration[0]?.count).toBe(1n);
  const users = await database.$transaction([
    database.user.create({
      data: { email: `${runId}-a@integration.invalid`, passwordHash: "integration-only", role: "ADMIN" },
    }),
    database.user.create({
      data: { email: `${runId}-b@integration.invalid`, passwordHash: "integration-only", role: "ADMIN" },
    }),
  ]);
  userIds.push(...users.map(({ id }) => id));
  ownerA = { id: users[0]!.id, role: "OWNER" };
  ownerB = { id: users[1]!.id, role: "OWNER" };
  const project = await database.project.create({
    data: { ownerId: ownerA.id, name: `${runId} project`, slug: runId, type: "MIXED" },
  });
  projectA = project.id;
  projectIds.push(project.id);
});

afterAll(async () => {
  try {
    await database.$transaction(async (transaction) => {
      await transaction.activityLog.deleteMany({ where: { ownerId: { in: userIds } } });
      await transaction.renderJobInput.deleteMany({ where: { jobId: { in: renderJobIds } } });
      await transaction.renderJob.deleteMany({ where: { id: { in: renderJobIds }, ownerId: { in: userIds } } });
      await transaction.assetStorageObject.deleteMany({
        where: { assetId: { in: assetIds }, ownerId: { in: userIds }, sourceObjectId: { not: null } },
      });
      await transaction.assetStorageObject.deleteMany({
        where: { assetId: { in: assetIds }, ownerId: { in: userIds } },
      });
      await transaction.asset.deleteMany({ where: { id: { in: assetIds }, ownerId: { in: userIds } } });
      await transaction.project.deleteMany({ where: { id: { in: projectIds }, ownerId: { in: userIds } } });
      await transaction.user.deleteMany({ where: { id: { in: userIds } } });
    });
    expect(await database.asset.count({ where: { id: { in: assetIds } } })).toBe(0);
  } finally {
    await database.$disconnect();
  }
});

describe.sequential("secure asset lifecycle on PostgreSQL with fake storage", () => {
  it("finalizes exactly once under concurrent completion and supports idempotent retry", async () => {
    const png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#223344" },
    }).png().toBuffer();
    const asset = await prepare(png);
    const beforeReads = storage.readCalls;
    const concurrent = await Promise.allSettled([
      service.completeUpload(ownerA, asset.id, {}),
      service.completeUpload(ownerA, asset.id, {}),
    ]);
    expect(concurrent.some(({ status }) => status === "fulfilled")).toBe(true);
    expect(storage.readCalls - beforeReads).toBe(2);
    expect(storage.readKeys.filter((key) => key === stagingKeys.get(asset.id))).toHaveLength(1);
    expect(storage.readKeys.filter((key) => key === asset.objectKey)).toHaveLength(1);
    expect((await database.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("READY");
    await expect(service.completeUpload(ownerA, asset.id, {})).resolves.toMatchObject({ status: "READY" });
    expect(storage.readCalls - beforeReads).toBe(2);
  });

  it("enforces owner isolation for completion and signed reads", async () => {
    const ready = await database.asset.findFirstOrThrow({ where: { ownerId: ownerA.id, status: "READY" } });
    await expect(service.completeUpload(ownerB, ready.id, {})).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(service.createReadUrl(ownerB, ready.id)).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(service.createReadUrl(ownerA, ready.id)).resolves.toMatchObject({ assetId: ready.id });
  });

  it("includes verified private derivatives in owner quota accounting", async () => {
    const ready = await database.asset.findFirstOrThrow({
      where: { ownerId: ownerA.id, status: "READY", storageLayout: "STAGED_IMMUTABLE_V1" },
    });
    const original = await database.assetStorageObject.findUniqueOrThrow({
      where: { assetId_role: { assetId: ready.id, role: "ORIGINAL" } },
    });
    const before = await new AssetRepository(database).reservedBytes(ownerA.id);
    await database.assetStorageObject.create({
      data: {
        assetId: ready.id,
        ownerId: ownerA.id,
        role: "THUMBNAIL_GRID",
        state: "VERIFIED",
        bucket: config.bucket,
        objectKey: `development/owners/${ownerA.id}/projects/${projectA}/assets/${ready.id}/derivatives/grid/${"b".repeat(32)}`,
        contentType: "image/webp",
        byteSize: 123n,
        width: 16,
        height: 16,
        checksumSha256: "c".repeat(64),
        storageEtag: "thumbnail-etag",
        sourceObjectId: original.id,
        immutableAt: new Date(),
      },
    });
    expect(await new AssetRepository(database).reservedBytes(ownerA.id)).toBe(before + 123n);
  });

  it("rejects a magic-byte mismatch", async () => {
    const asset = await prepare(Buffer.from("not-a-png"), "spoofed.png");
    await expect(service.completeUpload(ownerA, asset.id, {})).rejects.toMatchObject({
      code: "ASSET_VERIFICATION_FAILED",
    });
    expect((await database.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("REJECTED");
  });

  it("returns transient storage failures to a recoverable pending state", async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "white" },
    }).png().toBuffer();
    const asset = await prepare(png, "retry.png");
    storage.transientHeadFailures.add(stagingKeys.get(asset.id)!);
    await expect(service.completeUpload(ownerA, asset.id, {})).rejects.toMatchObject({
      code: "ASSET_STORAGE_UNAVAILABLE",
      retryable: true,
    });
    expect((await database.asset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("PENDING_UPLOAD");
  });

  it("cleans expired/rejected objects idempotently and recovers stale verification", async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "black" },
    }).png().toBuffer();
    const expired = await prepare(png, "expired.png");
    await database.asset.update({
      where: { id: expired.id },
      data: { uploadExpiresAt: new Date(Date.now() - 1_000) },
    });
    const staleId = randomUUID();
    assetIds.push(staleId);
    await database.asset.create({
      data: {
        id: staleId,
        ownerId: ownerA.id,
        projectId: projectA,
        type: "SOURCE_IMAGE",
        status: "VERIFYING",
        storageLayout: "STAGED_IMMUTABLE_V1",
        integrityStatus: "PENDING",
        bucket: config.bucket,
        objectKey: `development/owners/${ownerA.id}/projects/${projectA}/assets/${staleId}/${"a".repeat(32)}`,
        verificationStartedAt: new Date(Date.now() - 700_000),
      },
    });
    const maintenance = new AssetMaintenanceService(database, storage, config);
    const dryRun = await maintenance.run({ limit: 100 });
    expect(dryRun.plannedDeletes).toBeGreaterThanOrEqual(1);
    expect(dryRun.plannedRecoveries).toBe(1);
    const first = await maintenance.run({ limit: 100, dryRun: false, confirmedEnvironment: "development" });
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    expect(first.recovered).toBe(1);
    expect((await database.asset.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe("DELETED");
    expect((await database.asset.findUniqueOrThrow({ where: { id: staleId } })).status).toBe("PENDING_UPLOAD");
    const second = await maintenance.run({ limit: 100, dryRun: false, confirmedEnvironment: "development" });
    expect(second.deleted).toBe(0);
  });

  it("lists owner-scoped assets with database filters and pagination", async () => {
    const result = await service.list(ownerA, {
      projectId: projectA,
      assetType: "SOURCE_IMAGE",
      sort: "oldest",
      page: 1,
      pageSize: 2,
    });
    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(result.total).toBeGreaterThan(0);
    expect(result.items.every((asset) => asset.project?.id === projectA)).toBe(true);
    expect(await service.list(ownerB, { page: 1, pageSize: 20 })).toMatchObject({ total: 0 });
    await expect(service.get(ownerB, result.items[0]!.id)).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });
  });

  it("logically deletes unreferenced assets and blocks referenced deletion", async () => {
    const png = await sharp({
      create: { width: 6, height: 6, channels: 3, background: "#abcdef" },
    }).png().toBuffer();
    const deletable = await prepare(png, "deletable.png");
    await expect(service.requestDeletion(ownerA, deletable.id)).resolves.toEqual({
      assetId: deletable.id,
      status: "DELETED",
    });
    await expect(service.requestDeletion(ownerA, deletable.id)).resolves.toEqual({
      assetId: deletable.id,
      status: "DELETED",
    });
    expect(await database.asset.findUniqueOrThrow({ where: { id: deletable.id } })).toMatchObject({
      status: "DELETED",
      deletedAt: null,
    });
    expect(await database.activityLog.count({
      where: { ownerId: ownerA.id, entityId: deletable.id, action: "ASSET_DELETION_REQUESTED" },
    })).toBe(1);
    const cleanup = await new AssetMaintenanceService(database, storage, config).run({
      limit: 100,
      dryRun: false,
      confirmedEnvironment: "development",
    });
    expect(cleanup.deleted).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(deletable.objectKey)).toBe(false);
    expect((await database.asset.findUniqueOrThrow({ where: { id: deletable.id } })).deletedAt)
      .toBeInstanceOf(Date);

    const referenced = await prepare(png, "referenced.png");
    await service.completeUpload(ownerA, referenced.id, {});
    const referencedObject = await database.assetStorageObject.findFirstOrThrow({
      where: { assetId: referenced.id, role: "ORIGINAL", state: "VERIFIED" },
    });
    const inputSnapshot = [{
      assetId: referenced.id, role: "SOURCE_IMAGE", position: 0,
      storageObjectId: referencedObject.id, checksumSha256: referencedObject.checksumSha256!,
      storageEtag: referencedObject.storageEtag!, contentType: referencedObject.contentType!,
    }];
    const job = await database.renderJob.create({
      data: {
        ownerId: ownerA.id,
        projectId: projectA,
        type: "IMAGE_RENDER",
        status: "CREATED",
        idempotencyKey: `${runId}-referenced`,
        parameters: {},
        inputSnapshot,
      },
    });
    renderJobIds.push(job.id);
    await database.renderJobInput.create({
      data: { jobId: job.id, ownerId: ownerA.id, assetId: referenced.id, role: "SOURCE_IMAGE", position: 0, storageObjectId: referencedObject.id, checksumSha256: referencedObject.checksumSha256!, storageEtag: referencedObject.storageEtag!, contentType: referencedObject.contentType! },
    });
    await expect(service.requestDeletion(ownerA, referenced.id)).rejects.toMatchObject({
      code: "ASSET_REFERENCED",
    });
    expect((await database.asset.findUniqueOrThrow({ where: { id: referenced.id } })).status)
      .not.toBe("DELETED");
  });
});
