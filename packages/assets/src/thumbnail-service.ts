import { createHash } from "node:crypto";

import { requireRole, type AuthenticatedPrincipal } from "@archrender/auth";
import {
  AssetRepository,
  AssetStorageObjectRepository,
  type PrismaClient,
} from "@archrender/database";
import sharp from "sharp";

import type { AssetStorageConfig } from "./config";
import { AssetApplicationError } from "./errors";
import { ImmutableObjectFinalizer } from "./immutable-object-finalizer";
import { createThumbnailObjectKey } from "./object-key";
import type { StorageProvider } from "./storage-provider";
import type { StorageObjectKey } from "./types";

export type ThumbnailVariant = "grid" | "detail";

const variants = {
  grid: { width: 480, height: 330, quality: 76, role: "THUMBNAIL_GRID", storageRole: "thumbnail-grid-v1" },
  detail: { width: 1280, height: 960, quality: 84, role: "THUMBNAIL_DETAIL", storageRole: "thumbnail-detail-v1" },
} as const;

function normalizedEtag(value: string | null | undefined) {
  return value?.trim().replace(/^"|"$/g, "") || null;
}

function legacyStorageEtag(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)["storageEtag"];
  return typeof value === "string" ? normalizedEtag(value) : null;
}

export class ThumbnailService {
  private activeGenerations = 0;

  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageProvider,
    private readonly config: AssetStorageConfig,
  ) {}

  async createReadUrl(principal: AuthenticatedPrincipal, assetId: string, variant: ThumbnailVariant) {
    requireRole(principal, ["OWNER"]);
    const policy = variants[variant];
    const asset = await new AssetRepository(this.database).findVisibleById(principal.id, assetId);
    if (!asset || asset.status !== "READY" || !["VERIFIED_IMMUTABLE", "LEGACY_GUARDED"].includes(asset.integrityStatus)) {
      throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
    }
    if (!asset.projectId) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Source identity is unavailable.");
    }
    const objects = new AssetStorageObjectRepository(this.database);
    const randomId = createHash("sha256").update(`${asset.id}:${variant}:v1`).digest("hex").slice(0, 32);
    const key = createThumbnailObjectKey({
      environment: this.config.environment,
      ownerId: principal.id,
      projectId: asset.projectId,
      assetId: asset.id,
      randomId,
    }, variant);
    const existing = await objects.findByRole(principal.id, asset.id, policy.role);
    if (existing?.state === "VERIFIED" && existing.storageEtag) {
      const head = await this.storage.headObject(key);
      const metadataAssetId = head.metadata["assetid"] ?? head.metadata["assetId"];
      if (normalizedEtag(head.etag) !== existing.storageEtag || metadataAssetId !== asset.id) {
        throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Thumbnail identity changed.");
      }
      const url = await this.storage.createPresignedReadUrl(key, this.config.signedUrlTtlSeconds);
      return { assetId: asset.id, variant, url, expiresAt: new Date(Date.now() + this.config.signedUrlTtlSeconds * 1_000) };
    }

    const source = asset.storageLayout === "STAGED_IMMUTABLE_V1"
      ? await objects.findByRole(principal.id, asset.id, "ORIGINAL")
      : null;
    if (asset.storageLayout === "STAGED_IMMUTABLE_V1" && (!source || source.state !== "VERIFIED")) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Verified original is unavailable.");
    }
    const sourceKey = (source?.objectKey ?? asset.objectKey) as StorageObjectKey;
    const sourceHead = await this.storage.headObject(sourceKey);
    const sourceEtag = sourceHead.etag?.trim() || null;
    if (!sourceEtag) throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Source ETag is unavailable.");
    if (asset.integrityStatus === "LEGACY_GUARDED") {
      const expectedLegacyEtag = legacyStorageEtag(asset.metadata);
      if (!expectedLegacyEtag || normalizedEtag(sourceEtag) !== expectedLegacyEtag) {
        throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Legacy source identity changed.");
      }
      const url = await this.storage.createPresignedReadUrl(sourceKey, this.config.signedUrlTtlSeconds);
      return { assetId: asset.id, variant, url, expiresAt: new Date(Date.now() + this.config.signedUrlTtlSeconds * 1_000) };
    }
    if (!asset.checksumSha256) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Source checksum is unavailable.");
    }
    const sourceBytes = await this.storage.readObject(sourceKey, this.config.maxUploadBytes, { ifMatch: sourceEtag });
    if (createHash("sha256").update(sourceBytes.bytes).digest("hex") !== asset.checksumSha256) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Source checksum changed.");
    }
    const releaseGeneration = this.tryAcquireGeneration();
    if (!releaseGeneration) {
      throw new AssetApplicationError(
        "ASSET_CONCURRENT_LIMIT",
        "Thumbnail generation capacity is temporarily exhausted.",
        true,
      );
    }
    try {
      const reserved = await objects.reserveDerivative({
        ownerId: principal.id,
        assetId: asset.id,
        role: policy.role,
        bucket: this.config.bucket,
        objectKey: key,
        contentType: "image/webp",
        ...(source ? { sourceObjectId: source.id } : {}),
      });

      if (reserved.state !== "VERIFIED") {
        try {
        const output = await sharp(sourceBytes.bytes, {
          limitInputPixels: this.config.maxDecodedPixels,
          failOn: "error",
        }).rotate().resize({
          width: policy.width,
          height: policy.height,
          fit: variant === "grid" ? "cover" : "inside",
          withoutEnlargement: true,
        }).webp({ quality: policy.quality, effort: 4 }).toBuffer({ resolveWithObject: true });
        const checksumSha256 = createHash("sha256").update(output.data).digest("hex");
        const identity = await new ImmutableObjectFinalizer(this.storage, this.config.maxUploadBytes).finalize({
          assetId: asset.id,
          finalKey: key,
          bytes: output.data,
          contentType: "image/webp",
          checksumSha256,
          role: policy.storageRole,
        });
        const updated = await objects.markVerified({
          ownerId: principal.id,
          id: reserved.id,
          state: "VERIFIED",
          contentType: "image/webp",
          byteSize: BigInt(output.data.byteLength),
          width: output.info.width,
          height: output.info.height,
          checksumSha256,
          storageEtag: identity.etag,
          immutableAt: new Date(),
        });
        if (updated.count !== 1) throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Thumbnail identity changed.");
        } catch (error) {
          await objects.recordAttempt(principal.id, reserved.id, "THUMBNAIL_GENERATION_FAILED");
          throw error;
        }
      }
    } finally {
      releaseGeneration();
    }
    const derivative = await objects.findByRole(principal.id, asset.id, policy.role);
    if (!derivative || derivative.state !== "VERIFIED" || !derivative.storageEtag) {
      throw new AssetApplicationError("ASSET_STORAGE_UNAVAILABLE", "Thumbnail is not ready.", true);
    }
    const head = await this.storage.headObject(key);
    const metadataAssetId = head.metadata["assetid"] ?? head.metadata["assetId"];
    if (normalizedEtag(head.etag) !== derivative.storageEtag || metadataAssetId !== asset.id) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Thumbnail identity changed.");
    }
    const url = await this.storage.createPresignedReadUrl(key, this.config.signedUrlTtlSeconds);
    return { assetId: asset.id, variant, url, expiresAt: new Date(Date.now() + this.config.signedUrlTtlSeconds * 1_000) };
  }

  private tryAcquireGeneration(): (() => void) | null {
    if (this.activeGenerations >= this.config.maxConcurrentVerifications) return null;
    this.activeGenerations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGenerations -= 1;
    };
  }
}
