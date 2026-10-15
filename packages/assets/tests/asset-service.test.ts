import { describe, expect, it, vi } from "vitest";

import type { AssetStorageConfig } from "../src/config.js";
import { AssetService } from "../src/asset-service.js";
import type { StorageProvider } from "../src/storage-provider.js";

const config: AssetStorageConfig = {
  accountId: "account",
  bucket: "private-assets",
  endpoint: "https://account.r2.cloudflarestorage.com",
  credentials: { accessKeyId: "placeholder", secretAccessKey: "placeholder" },
  environment: "development",
  maxUploadBytes: 25 * 1024 * 1024,
  maxImageDimension: 16_384,
  maxDecodedPixels: 100_000_000,
  signedUrlTtlSeconds: 300,
  initiateRatePerMinute: 20,
  maxConcurrentUploads: 8,
  ownerQuotaBytes: 10 * 1024 ** 3,
  verificationStaleSeconds: 600,
  maxVerificationAttempts: 3,
  maxConcurrentVerifications: 2,
};

const input = {
  requestId: "00000000-0000-4000-8000-000000000010",
  projectId: "00000000-0000-4000-8000-000000000020",
  assetType: "SOURCE_IMAGE" as const,
  originalName: "source.png",
  contentType: "image/png" as const,
  byteSize: 1_024,
};

const existing = {
  id: "00000000-0000-4000-8000-000000000030",
  ownerId: "00000000-0000-4000-8000-000000000040",
  projectId: input.projectId,
  type: input.assetType,
  status: "PENDING_UPLOAD",
  objectKey: "development/controlled-key",
  originalName: input.originalName,
  contentType: input.contentType,
  byteSize: BigInt(input.byteSize),
  uploadExpiresAt: new Date("2026-10-14T00:05:00.000Z"),
};

describe("AssetService idempotency", () => {
  it("returns the same pending asset for the same owner request", async () => {
    const database = {
      asset: { findUnique: vi.fn().mockResolvedValue(existing) },
      project: { findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE" }) },
    };
    const storage = {
      createPresignedUpload: vi.fn().mockResolvedValue({
        method: "PUT", url: "https://signed.invalid", expiresAt: existing.uploadExpiresAt, requiredHeaders: {},
      }),
    } as unknown as StorageProvider;
    const service = new AssetService(
      database as never,
      storage,
      config,
      () => new Date("2026-10-14T00:00:00.000Z"),
    );
    const first = await service.prepareUpload({ id: existing.ownerId, role: "OWNER" }, input);
    const second = await service.prepareUpload({ id: existing.ownerId, role: "OWNER" }, input);
    expect(first.assetId).toBe(existing.id);
    expect(second.assetId).toBe(existing.id);
    expect(database.asset.findUnique).toHaveBeenCalledWith({
      where: { ownerId_uploadRequestId: { ownerId: existing.ownerId, uploadRequestId: input.requestId } },
    });
  });

  it("rejects reuse of a request id with different content", async () => {
    const database = {
      asset: { findUnique: vi.fn().mockResolvedValue(existing) },
      project: { findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE" }) },
    };
    const service = new AssetService(database as never, {} as StorageProvider, config);
    await expect(service.prepareUpload(
      { id: existing.ownerId, role: "OWNER" },
      { ...input, byteSize: input.byteSize + 1 },
    )).rejects.toMatchObject({ code: "ASSET_IDEMPOTENCY_CONFLICT" });
  });

  it("signs only the staging key for immutable uploads", async () => {
    const stagingKey = "development/owners/o/projects/p/assets/a/staging/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const immutable = {
      ...existing,
      storageLayout: "STAGED_IMMUTABLE_V1",
      integrityStatus: "PENDING",
      objectKey: "development/owners/o/projects/p/assets/a/original/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const database = {
      asset: { findUnique: vi.fn().mockResolvedValue(immutable) },
      assetStorageObject: { findFirst: vi.fn().mockResolvedValue({ state: "RESERVED", objectKey: stagingKey }) },
      project: { findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE" }) },
    };
    const createPresignedUpload = vi.fn().mockResolvedValue({
      method: "PUT", url: "https://signed.invalid", expiresAt: existing.uploadExpiresAt, requiredHeaders: {},
    });
    const service = new AssetService(
      database as never,
      { createPresignedUpload } as unknown as StorageProvider,
      config,
      () => new Date("2026-10-14T00:00:00.000Z"),
    );
    await service.prepareUpload({ id: existing.ownerId, role: "OWNER" }, input);
    expect(createPresignedUpload).toHaveBeenCalledWith(expect.objectContaining({ key: stagingKey }));
    expect(createPresignedUpload).not.toHaveBeenCalledWith(expect.objectContaining({ key: immutable.objectKey }));
  });

  it("keeps legacy READY assets on their existing guarded object", async () => {
    const legacy = {
      ...existing,
      status: "READY",
      storageLayout: "LEGACY_SINGLE_OBJECT",
      integrityStatus: "LEGACY_GUARDED",
      metadata: { storageEtag: "legacy-etag" },
    };
    const database = { asset: { findUnique: vi.fn().mockResolvedValue(legacy) } };
    const storage = {
      headObject: vi.fn().mockResolvedValue({
        contentLength: input.byteSize,
        contentType: input.contentType,
        etag: '"legacy-etag"',
        metadata: { assetid: legacy.id },
      }),
      createPresignedReadUrl: vi.fn().mockResolvedValue("https://signed.invalid/legacy"),
    } as unknown as StorageProvider;
    const service = new AssetService(database as never, storage, config);
    await expect(service.createReadUrl({ id: existing.ownerId, role: "OWNER" }, legacy.id))
      .resolves.toMatchObject({ assetId: legacy.id });
    expect(storage.createPresignedReadUrl).toHaveBeenCalledWith(
      legacy.objectKey,
      config.signedUrlTtlSeconds,
    );
  });
});
