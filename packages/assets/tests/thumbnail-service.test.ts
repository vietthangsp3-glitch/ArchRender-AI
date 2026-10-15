import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { AssetStorageConfig } from "../src/config.js";
import { StorageError } from "../src/errors.js";
import type { StorageProvider } from "../src/storage-provider.js";
import { ThumbnailService } from "../src/thumbnail-service.js";
import type { StorageObjectKey } from "../src/types.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000004";
const sourceKey = `development/owners/${ownerId}/projects/${projectId}/assets/${assetId}/original/${"a".repeat(32)}`;

const config: AssetStorageConfig = {
  accountId: "account", bucket: "private-assets", endpoint: "https://account.r2.cloudflarestorage.com",
  credentials: { accessKeyId: "placeholder", secretAccessKey: "placeholder" }, environment: "development",
  maxUploadBytes: 1024 * 1024, maxImageDimension: 4096, maxDecodedPixels: 4_000_000,
  signedUrlTtlSeconds: 300, initiateRatePerMinute: 20, maxConcurrentUploads: 8,
  ownerQuotaBytes: 1024, verificationStaleSeconds: 600,
  maxVerificationAttempts: 3, maxConcurrentVerifications: 2,
};

class MemoryStorage implements StorageProvider {
  objects = new Map<string, { bytes: Uint8Array; contentType: string; etag: string; metadata: Record<string, string> }>();
  readCount = 0;
  createPresignedUpload = vi.fn() as never;
  async createPresignedReadUrl(key: StorageObjectKey) { return `https://signed.invalid/${encodeURIComponent(key)}`; }
  async headObject(key: StorageObjectKey) {
    const object = this.objects.get(key);
    if (!object) throw new StorageError("NOT_FOUND", "head", false);
    return { contentLength: object.bytes.byteLength, contentType: object.contentType, etag: `"${object.etag}"`, metadata: object.metadata };
  }
  async readObject(key: StorageObjectKey) {
    this.readCount += 1;
    const object = this.objects.get(key);
    if (!object) throw new StorageError("NOT_FOUND", "read", false);
    return { ...(await this.headObject(key)), bytes: object.bytes };
  }
  async createImmutableObject(input: { key: StorageObjectKey; bytes: Uint8Array; contentType: string; metadata: Readonly<Record<string, string>> }) {
    if (this.objects.has(input.key)) throw new StorageError("PRECONDITION_FAILED", "put", false);
    const etag = createHash("md5").update(input.bytes).digest("hex");
    this.objects.set(input.key, { bytes: input.bytes, contentType: input.contentType, etag, metadata: { ...input.metadata } });
    return this.headObject(input.key);
  }
  async deleteObject(key: StorageObjectKey) { this.objects.delete(key); }
  async objectExists(key: StorageObjectKey) { return this.objects.has(key); }
}

async function setup() {
  const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#345678" } }).jpeg().toBuffer();
  const sourceChecksum = createHash("sha256").update(source).digest("hex");
  const storage = new MemoryStorage();
  storage.objects.set(sourceKey, { bytes: source, contentType: "image/jpeg", etag: "source-etag", metadata: { assetId } });
  let derivative: Record<string, unknown> | null = null;
  const asset = {
    id: assetId, ownerId, projectId, status: "READY", integrityStatus: "VERIFIED_IMMUTABLE",
    storageLayout: "STAGED_IMMUTABLE_V1", objectKey: sourceKey, checksumSha256: sourceChecksum,
  };
  const original = { id: sourceId, assetId, ownerId, role: "ORIGINAL", state: "VERIFIED", objectKey: sourceKey };
  const database = {
    asset: { findFirst: vi.fn(({ where }) => where.ownerId === ownerId ? asset : null) },
    assetStorageObject: {
      findFirst: vi.fn(({ where }) => where.role === "ORIGINAL" ? original : derivative),
      upsert: vi.fn(({ create }) => {
        derivative ??= { id: "00000000-0000-4000-8000-000000000005", assetId, ownerId, ...create };
        return derivative;
      }),
      updateMany: vi.fn(({ data }) => {
        derivative = { ...derivative, ...data, storageEtag: data.storageEtag };
        return { count: 1 };
      }),
    },
  };
  return { asset, source, storage, database, service: new ThumbnailService(database as never, storage, config) };
}

describe("private thumbnail service", () => {
  it("derives an immutable private GRID thumbnail without changing the original", async () => {
    const { source, storage, database, service } = await setup();
    const before = createHash("sha256").update(source).digest("hex");
    const result = await service.createReadUrl({ id: ownerId, role: "OWNER" }, assetId, "grid");
    const derivative = [...storage.objects.entries()].find(([key]) => key.includes("/derivatives/grid/"));

    expect(result).toMatchObject({ assetId, variant: "grid" });
    expect(derivative).toBeDefined();
    expect(derivative?.[1].contentType).toBe("image/webp");
    expect((await sharp(derivative?.[1].bytes).metadata()).width).toBeLessThanOrEqual(480);
    expect(createHash("sha256").update(storage.objects.get(sourceKey)!.bytes).digest("hex")).toBe(before);
    expect(database.assetStorageObject.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        source: { connect: { id_assetId_ownerId: { id: sourceId, assetId, ownerId } } },
      }),
    }));
  });

  it("is idempotent and reuses the deterministic derivative object", async () => {
    const { storage, service } = await setup();
    await service.createReadUrl({ id: ownerId, role: "OWNER" }, assetId, "detail");
    const count = storage.objects.size;
    const reads = storage.readCount;
    await service.createReadUrl({ id: ownerId, role: "OWNER" }, assetId, "detail");
    expect(storage.objects.size).toBe(count);
    expect(storage.readCount).toBe(reads);
  });

  it("keeps guarded legacy assets readable without creating an unverified derivative", async () => {
    const { asset, storage, service } = await setup();
    Object.assign(asset, {
      storageLayout: "LEGACY_SINGLE_OBJECT",
      integrityStatus: "LEGACY_GUARDED",
      metadata: { storageEtag: "source-etag" },
    });

    const result = await service.createReadUrl({ id: ownerId, role: "OWNER" }, assetId, "grid");

    expect(result.url).toContain(encodeURIComponent(sourceKey));
    expect(storage.objects.size).toBe(1);
    expect(storage.readCount).toBe(0);
  });

  it("enforces owner isolation before reading the source", async () => {
    const { storage, service } = await setup();
    await expect(service.createReadUrl(
      { id: "00000000-0000-4000-8000-000000000099", role: "OWNER" },
      assetId,
      "grid",
    )).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(storage.objects.size).toBe(1);
  });

  it("fails safely on invalid source bytes without mutating the verified original", async () => {
    const { asset, storage, database, service } = await setup();
    const invalid = Buffer.from("synthetic-invalid-image");
    storage.objects.set(sourceKey, {
      bytes: invalid,
      contentType: "image/jpeg",
      etag: "invalid-source-etag",
      metadata: { assetId },
    });
    asset.checksumSha256 = createHash("sha256").update(invalid).digest("hex");

    await expect(service.createReadUrl({ id: ownerId, role: "OWNER" }, assetId, "grid"))
      .rejects.toBeDefined();

    expect(storage.objects.size).toBe(1);
    expect(storage.objects.get(sourceKey)?.bytes).toEqual(invalid);
    expect(database.assetStorageObject.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastErrorCode: "THUMBNAIL_GENERATION_FAILED" }),
    }));
  });
});
