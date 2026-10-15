import { createHash, randomUUID } from "node:crypto";

import { requireRole, type AuthenticatedPrincipal } from "@archrender/auth";
import {
  ActivityLogRepository,
  type Asset,
  type AssetStorageObject,
  AssetRepository,
  AssetStorageObjectRepository,
  Prisma,
  type PrismaClient,
  ProjectRepository,
} from "@archrender/database";

import type { AssetStorageConfig } from "./config";
import { AssetApplicationError, type CompletionTrace, StorageError } from "./errors";
import { inspectImage } from "./image-inspection";
import { ImmutableObjectFinalizer } from "./immutable-object-finalizer";
import { createFinalObjectKey, createStagingObjectKey } from "./object-key";
import { validateUploadIntent } from "./policy";
import { IMAGE_MIME_TYPES } from "./policy";
import { assertUploadCapacity } from "./quota";
import {
  assetIdSchema,
  completeAssetUploadSchema,
  listAssetsSchema,
  prepareAssetUploadSchema,
  type CompleteAssetUploadInput,
  type PrepareAssetUploadInput,
} from "./schemas";
import {
  UPLOAD_ASSET_TYPES,
  type AssetListResult,
  type AssetSummary,
  type InspectedImage,
} from "./types";
import type { StorageProvider } from "./storage-provider";
import type { StorageObjectKey } from "./types";

function normalizedEtag(etag: string | null | undefined): string | null {
  return etag?.trim().replace(/^"|"$/g, "") || null;
}

function metadataEtag(asset: Asset): string | null {
  if (!asset.metadata || typeof asset.metadata !== "object" || Array.isArray(asset.metadata)) return null;
  const value = (asset.metadata as Record<string, unknown>)["storageEtag"];
  return typeof value === "string" ? value : null;
}

class VerificationGate {
  private active = 0;

  constructor(private readonly maximum: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maximum) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

function toAssetResult(asset: Asset) {
  return {
    assetId: asset.id,
    projectId: asset.projectId,
    assetType: asset.type,
    status: asset.status,
    contentType: asset.contentType,
    byteSize: asset.byteSize === null ? null : Number(asset.byteSize),
    width: asset.width,
    height: asset.height,
    checksumSha256: asset.checksumSha256,
  };
}

function toAssetSummary(asset: Asset & {
  project: { id: string; name: string; status: "ACTIVE" | "ARCHIVED" } | null;
}): AssetSummary {
  return {
    id: asset.id,
    project: asset.project,
    assetType: asset.type,
    status: asset.status,
    originalName: asset.originalName,
    contentType: asset.contentType,
    byteSize: asset.byteSize === null ? null : Number(asset.byteSize),
    width: asset.width,
    height: asset.height,
    uploadExpired: asset.status === "PENDING_UPLOAD" &&
      Boolean(asset.uploadExpiresAt && asset.uploadExpiresAt.getTime() <= Date.now()),
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    verifiedAt: asset.verifiedAt?.toISOString() ?? null,
  };
}

export class AssetService {
  private readonly verificationGate: VerificationGate;

  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageProvider,
    private readonly config: AssetStorageConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.verificationGate = new VerificationGate(config.maxConcurrentVerifications);
  }

  async prepareUpload(principal: AuthenticatedPrincipal, input: unknown) {
    requireRole(principal, ["OWNER"]);
    const parsed = prepareAssetUploadSchema.parse(input);
    const validated = validateUploadIntent({
      assetType: parsed.assetType,
      originalName: parsed.originalName,
      declaredContentType: parsed.contentType,
      declaredByteSize: parsed.byteSize,
    }, { maxUploadBytes: this.config.maxUploadBytes });

    const assets = new AssetRepository(this.database);
    const existing = await assets.findByUploadRequestId(principal.id, parsed.requestId);
    if (existing) {
      await this.requireActiveProject(principal.id, existing.projectId);
      return this.signExisting(existing, parsed);
    }

    const assetId = randomUUID();
    const keyInput = {
      environment: this.config.environment,
      ownerId: principal.id,
      projectId: parsed.projectId,
      assetId,
    };
    const objectKey = createFinalObjectKey(keyInput);
    const stagingObjectKey = createStagingObjectKey(keyInput);
    const uploadExpiresAt = new Date(this.now().getTime() + this.config.signedUrlTtlSeconds * 1_000);

    let asset: Asset;
    try {
      asset = await this.database.$transaction(async (transaction) => {
        await transaction.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${principal.id}, 0))`,
        );
        const transactionAssets = new AssetRepository(transaction);
        const raced = await transactionAssets.findByUploadRequestId(principal.id, parsed.requestId);
        if (raced) return raced;

        const project = await new ProjectRepository(transaction).findById(principal.id, parsed.projectId);
        if (!project) throw new AssetApplicationError("ASSET_PROJECT_NOT_FOUND", "Project not found.");
        if (project.status === "ARCHIVED") {
          throw new AssetApplicationError("ASSET_PROJECT_ARCHIVED", "Archived projects are read-only.");
        }

        const minuteAgo = new Date(this.now().getTime() - 60_000);
        const [recentInitiatedUploads, concurrentUploads, reservedBytes] = await Promise.all([
          transactionAssets.countRecentInitiated(principal.id, minuteAgo),
          transactionAssets.countConcurrentUploads(principal.id),
          transactionAssets.reservedBytes(principal.id),
        ]);
        assertUploadCapacity(
          { recentInitiatedUploads, concurrentUploads, reservedBytes },
          parsed.byteSize,
          this.config,
        );

        const created = await transactionAssets.create({
          id: assetId,
          ownerId: principal.id,
          projectId: parsed.projectId,
          type: parsed.assetType,
          status: "PENDING_UPLOAD",
          bucket: this.config.bucket,
          objectKey,
          originalName: validated.sanitizedName,
          contentType: validated.contentType,
          byteSize: BigInt(parsed.byteSize),
          uploadRequestId: parsed.requestId,
          uploadExpiresAt,
          storageLayout: "STAGED_IMMUTABLE_V1",
          integrityStatus: "PENDING",
        });
        const storageObjects = new AssetStorageObjectRepository(transaction);
        await storageObjects.create({
          ownerId: principal.id,
          assetId: created.id,
          role: "STAGING",
          bucket: this.config.bucket,
          objectKey: stagingObjectKey,
          contentType: validated.contentType,
          byteSize: BigInt(parsed.byteSize),
          uploadExpiresAt,
          cleanupAfter: new Date(uploadExpiresAt.getTime() + 60_000),
        });
        await storageObjects.create({
          ownerId: principal.id,
          assetId: created.id,
          role: "ORIGINAL",
          bucket: this.config.bucket,
          objectKey,
          contentType: validated.contentType,
          byteSize: BigInt(parsed.byteSize),
        });
        await new ActivityLogRepository(transaction).create({
          ownerId: principal.id,
          actorUserId: principal.id,
          action: "ASSET_UPLOAD_PREPARED",
          entityType: "ASSET",
          entityId: created.id,
          requestId: parsed.requestId,
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await assets.findByUploadRequestId(principal.id, parsed.requestId);
        if (raced) return this.signExisting(raced, parsed);
      }
      throw error;
    }
    await this.requireActiveProject(principal.id, asset.projectId);
    return this.signExisting(asset, parsed);
  }

  async list(principal: AuthenticatedPrincipal, input: unknown): Promise<AssetListResult> {
    requireRole(principal, ["OWNER"]);
    const parsed = listAssetsSchema.parse(input);
    const result = await new AssetRepository(this.database).listPage({
      ownerId: principal.id,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.assetType ? { type: parsed.assetType } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.search ? { search: parsed.search } : {}),
      sort: parsed.sort,
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize,
    });
    return {
      items: result.items.map(toAssetSummary),
      total: result.total,
      page: parsed.page,
      pageSize: parsed.pageSize,
      pageCount: Math.max(1, Math.ceil(result.total / parsed.pageSize)),
      policy: {
        maxUploadBytes: this.config.maxUploadBytes,
        acceptedContentTypes: IMAGE_MIME_TYPES,
        uploadAssetTypes: UPLOAD_ASSET_TYPES,
      },
    };
  }

  async get(principal: AuthenticatedPrincipal, assetId: string): Promise<AssetSummary> {
    requireRole(principal, ["OWNER"]);
    const id = assetIdSchema.parse(assetId);
    const asset = await new AssetRepository(this.database).findVisibleById(principal.id, id);
    if (!asset) throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
    return toAssetSummary(asset);
  }

  async requestDeletion(principal: AuthenticatedPrincipal, assetId: string) {
    requireRole(principal, ["OWNER"]);
    const id = assetIdSchema.parse(assetId);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
      );
      const assets = new AssetRepository(transaction);
      const asset = await assets.findById(principal.id, id);
      if (!asset) throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
      if (asset.status === "DELETED") return { assetId: id, status: "DELETED" as const };
      await this.requireActiveProjectWith(transaction, principal.id, asset.projectId);
      const references = await assets.countReferences(principal.id, id);
      const referenceCount = (references?._count.renderInputs ?? 0) +
        (references?._count.renderOutputs ?? 0);
      if (referenceCount > 0) {
        throw new AssetApplicationError("ASSET_REFERENCED", "Referenced assets cannot be deleted.");
      }
      const deleted = await assets.requestDeletion(principal.id, id);
      if (deleted.count !== 1) {
        throw new AssetApplicationError("ASSET_INVALID_STATE", "Asset deletion state changed.");
      }
      await new ActivityLogRepository(transaction).create({
        ownerId: principal.id,
        actorUserId: principal.id,
        action: "ASSET_DELETION_REQUESTED",
        entityType: "ASSET",
        entityId: id,
      });
      return { assetId: id, status: "DELETED" as const };
    });
  }

  async completeUpload(
    principal: AuthenticatedPrincipal,
    assetId: string,
    input: unknown,
    trace?: CompletionTrace,
  ) {
    if (trace) trace.phase = "claim";
    requireRole(principal, ["OWNER"]);
    const id = assetIdSchema.parse(assetId);
    const parsed = completeAssetUploadSchema.parse(input);
    const assets = new AssetRepository(this.database);
    let asset = await assets.findById(principal.id, id);
    if (!asset) throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
    await this.requireActiveProject(principal.id, asset.projectId);
    if (asset.status === "READY") return this.readyResult(asset, parsed);
    if (asset.status === "VERIFYING") {
      throw new AssetApplicationError("ASSET_VERIFICATION_IN_PROGRESS", "Verification in progress.", true);
    }
    if (asset.status !== "PENDING_UPLOAD") {
      throw new AssetApplicationError("ASSET_INVALID_STATE", "Asset is not pending upload.");
    }
    if (!asset.uploadExpiresAt || asset.uploadExpiresAt.getTime() <= this.now().getTime()) {
      throw new AssetApplicationError("ASSET_UPLOAD_EXPIRED", "Upload request expired.");
    }

    const releaseVerification = this.verificationGate.tryAcquire();
    if (!releaseVerification) {
      throw new AssetApplicationError(
        "ASSET_VERIFICATION_IN_PROGRESS",
        "Verification capacity is temporarily full.",
        true,
      );
    }

    let claimed: { count: number };
    try {
      claimed = await assets.transition({
        ownerId: principal.id,
        id,
        from: "PENDING_UPLOAD",
        to: "VERIFYING",
        verificationStartedAt: this.now(),
        rejectionCode: null,
      });
    } catch (error) {
      releaseVerification();
      throw error;
    }
    if (claimed.count !== 1) {
      releaseVerification();
      asset = await assets.findById(principal.id, id);
      if (asset?.status === "READY") return this.readyResult(asset, parsed);
      throw new AssetApplicationError("ASSET_VERIFICATION_IN_PROGRESS", "Verification in progress.", true);
    }

    const attemptNumber = asset.verificationAttempts + 1;
    try {
      if (trace) trace.phase = "conditional_staging_read";
      let staging: AssetStorageObject | null = null;
      let original: AssetStorageObject | null = null;
      let key = asset.objectKey as StorageObjectKey;
      if (asset.storageLayout === "STAGED_IMMUTABLE_V1") {
        const storageObjects = new AssetStorageObjectRepository(this.database);
        [staging, original] = await Promise.all([
          storageObjects.findByRole(principal.id, id, "STAGING"),
          storageObjects.findByRole(principal.id, id, "ORIGINAL"),
        ]);
        if (!staging || !original || staging.bucket !== asset.bucket || original.bucket !== asset.bucket) {
          throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Asset storage identity is incomplete.");
        }
        key = staging.objectKey as StorageObjectKey;
      }
      const head = await this.storage.headObject(key);
      this.assertObjectMetadata(asset, head, parsed);
      const stagingConditionalEtag = head.etag?.trim() || null;
      const expectedStagingEtag = normalizedEtag(head.etag);
      const content = await this.storage.readObject(
        key,
        this.config.maxUploadBytes,
        asset.storageLayout === "STAGED_IMMUTABLE_V1" && stagingConditionalEtag
          ? { ifMatch: stagingConditionalEtag }
          : {},
      );
      if (content.bytes.byteLength !== head.contentLength) {
        throw this.verificationFailure("OBJECT_LENGTH_CHANGED");
      }
      if (trace) trace.phase = "verify";
      const inspected = await inspectImage(
        content.bytes,
        asset.contentType as "image/jpeg" | "image/png" | "image/webp",
        this.config,
      );
      const checksumSha256 = createHash("sha256").update(content.bytes).digest("hex");
      if (parsed.checksumSha256 && parsed.checksumSha256.toLowerCase() !== checksumSha256) {
        throw this.verificationFailure("CHECKSUM_MISMATCH");
      }
      if (asset.storageLayout === "STAGED_IMMUTABLE_V1") {
        if (!staging || !original || !expectedStagingEtag) {
          throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Asset storage identity is incomplete.");
        }
        return await this.finalizeImmutableAsset({
          principal,
          asset,
          staging,
          original,
          bytes: content.bytes,
          inspected,
          checksumSha256,
          stagingEtag: expectedStagingEtag,
          ...(trace ? { trace } : {}),
        });
      }
      if (trace) trace.phase = "commit";
      const storageEtag = normalizedEtag(head.etag);
      const ready = await this.database.$transaction(async (transaction) => {
        const result = await new AssetRepository(transaction).transition({
          ownerId: principal.id,
          id,
          from: "VERIFYING",
          to: "READY",
          verificationStartedAt: null,
          verifiedAt: this.now(),
          rejectionCode: null,
          byteSize: BigInt(inspected.byteSize),
          width: inspected.width,
          height: inspected.height,
          checksumSha256,
          contentType: inspected.contentType,
          metadata: { storageEtag, verifiedFormat: inspected.format },
        });
        if (result.count !== 1) {
          throw new AssetApplicationError("ASSET_INVALID_STATE", "Verification claim was lost.");
        }
        await new ActivityLogRepository(transaction).create({
          ownerId: principal.id,
          actorUserId: principal.id,
          action: "ASSET_UPLOAD_VERIFIED",
          entityType: "ASSET",
          entityId: id,
          metadata: { width: inspected.width, height: inspected.height, byteSize: inspected.byteSize },
        });
        return new AssetRepository(transaction).findById(principal.id, id);
      });
      if (!ready) throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
      return toAssetResult(ready);
    } catch (error) {
      if (error instanceof AssetApplicationError && error.code === "ASSET_INTEGRITY_CONFLICT") {
        await this.quarantineVerification(principal.id, id, "IMMUTABLE_FINAL_CONFLICT");
        throw error;
      }
      if (this.isInvalidObject(error)) {
        await this.rejectVerification(principal.id, id, this.rejectionCode(error));
        throw error instanceof AssetApplicationError && error.code === "ASSET_VERIFICATION_FAILED"
          ? error
          : this.verificationFailure(this.rejectionCode(error), error);
      }
      await this.recoverVerification(
        principal.id,
        id,
        attemptNumber >= this.config.maxVerificationAttempts,
      );
      if (error instanceof AssetApplicationError) throw error;
      throw new AssetApplicationError(
        "ASSET_STORAGE_UNAVAILABLE",
        "Storage verification is temporarily unavailable.",
        true,
        { cause: error },
      );
    } finally {
      releaseVerification();
    }
  }

  async createReadUrl(principal: AuthenticatedPrincipal, assetId: string) {
    const id = assetIdSchema.parse(assetId);
    const asset = await new AssetRepository(this.database).findById(principal.id, id);
    if (!asset || asset.status !== "READY") {
      throw new AssetApplicationError("ASSET_NOT_FOUND", "Ready asset not found.");
    }
    let key = asset.objectKey as StorageObjectKey;
    let expectedEtag = metadataEtag(asset);
    if (asset.storageLayout === "STAGED_IMMUTABLE_V1") {
      if (asset.integrityStatus !== "VERIFIED_IMMUTABLE") {
        throw new AssetApplicationError("ASSET_NOT_FOUND", "Ready asset not found.");
      }
      const original = await new AssetStorageObjectRepository(this.database)
        .findByRole(principal.id, id, "ORIGINAL");
      if (!original || original.state !== "VERIFIED" || !original.storageEtag) {
        throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Final object identity is unavailable.");
      }
      key = original.objectKey as StorageObjectKey;
      expectedEtag = original.storageEtag;
    } else if (asset.integrityStatus !== "LEGACY_GUARDED") {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Legacy asset integrity is unavailable.");
    }
    const head = await this.storage.headObject(key);
    if (expectedEtag && normalizedEtag(head.etag) !== expectedEtag) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Stored object changed after verification.");
    }
    const url = await this.storage.createPresignedReadUrl(key, this.config.signedUrlTtlSeconds);
    return {
      assetId: asset.id,
      url,
      expiresAt: new Date(this.now().getTime() + this.config.signedUrlTtlSeconds * 1_000),
    };
  }

  private async finalizeImmutableAsset(input: {
    principal: AuthenticatedPrincipal;
    asset: Asset;
    staging: AssetStorageObject;
    original: AssetStorageObject;
    bytes: Uint8Array;
    inspected: InspectedImage;
    checksumSha256: string;
    stagingEtag: string;
    trace?: CompletionTrace;
  }) {
    const { principal, asset, staging, original, bytes, inspected, checksumSha256, stagingEtag, trace } = input;
    const finalKey = original.objectKey as StorageObjectKey;
    const finalIdentity = await new ImmutableObjectFinalizer(
      this.storage,
      this.config.maxUploadBytes,
    ).finalize(
      {
        finalKey,
        assetId: asset.id,
        bytes,
        contentType: inspected.contentType,
        checksumSha256,
      },
      (phase) => { if (trace) trace.phase = phase; },
    );
    if (trace) trace.phase = "commit";
    const finalizedAt = this.now();
    const ready = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${asset.id}, 0))`,
      );
      const transactionAssets = new AssetRepository(transaction);
      const current = await transactionAssets.findById(principal.id, asset.id);
      if (!current) throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
      if (current.status === "READY") {
        if (
          current.integrityStatus !== "VERIFIED_IMMUTABLE" ||
          current.checksumSha256 !== checksumSha256
        ) {
          throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Finalized asset identity changed.");
        }
        return current;
      }
      if (current.status !== "VERIFYING" || current.integrityStatus !== "PENDING") {
        throw new AssetApplicationError("ASSET_INVALID_STATE", "Verification claim was lost.");
      }
      const storageObjects = new AssetStorageObjectRepository(transaction);
      const [stagingUpdated, originalUpdated] = await Promise.all([
        storageObjects.markVerified({
          ownerId: principal.id,
          id: staging.id,
          state: "WRITTEN",
          contentType: inspected.contentType,
          byteSize: BigInt(bytes.byteLength),
          width: inspected.width,
          height: inspected.height,
          checksumSha256,
          storageEtag: stagingEtag,
          ...(staging.cleanupAfter ? { cleanupAfter: staging.cleanupAfter } : {}),
        }),
        storageObjects.markVerified({
          ownerId: principal.id,
          id: original.id,
          state: "VERIFIED",
          contentType: inspected.contentType,
          byteSize: BigInt(bytes.byteLength),
          width: inspected.width,
          height: inspected.height,
          checksumSha256,
          storageEtag: finalIdentity.etag,
          immutableAt: finalizedAt,
        }),
      ]);
      if (stagingUpdated.count !== 1 || originalUpdated.count !== 1) {
        throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Storage identity changed during finalization.");
      }
      const finalized = await transactionAssets.finalizeImmutable({
        ownerId: principal.id,
        id: asset.id,
        contentType: inspected.contentType,
        byteSize: BigInt(bytes.byteLength),
        width: inspected.width,
        height: inspected.height,
        checksumSha256,
        finalizedAt,
        metadata: {
          storageEtag: finalIdentity.etag,
          verifiedFormat: inspected.format,
          immutableStorageObjectId: original.id,
        },
      });
      if (finalized.count !== 1) {
        throw new AssetApplicationError("ASSET_INVALID_STATE", "Verification claim was lost.");
      }
      await new ActivityLogRepository(transaction).create({
        ownerId: principal.id,
        actorUserId: principal.id,
        action: "ASSET_IMMUTABLE_FINALIZED",
        entityType: "ASSET",
        entityId: asset.id,
        metadata: { width: inspected.width, height: inspected.height, byteSize: bytes.byteLength },
      });
      return transactionAssets.findById(principal.id, asset.id);
    });
    if (!ready) throw new AssetApplicationError("ASSET_NOT_FOUND", "Asset not found.");
    return toAssetResult(ready);
  }

  private async requireActiveProject(ownerId: string, projectId: string | null) {
    if (!projectId) throw new AssetApplicationError("ASSET_PROJECT_NOT_FOUND", "Project not found.");
    const project = await new ProjectRepository(this.database).findById(ownerId, projectId);
    if (!project) throw new AssetApplicationError("ASSET_PROJECT_NOT_FOUND", "Project not found.");
    if (project.status !== "ACTIVE") {
      throw new AssetApplicationError("ASSET_PROJECT_ARCHIVED", "Archived projects are read-only.");
    }
  }

  private async requireActiveProjectWith(
    database: Prisma.TransactionClient,
    ownerId: string,
    projectId: string | null,
  ) {
    if (!projectId) throw new AssetApplicationError("ASSET_PROJECT_NOT_FOUND", "Project not found.");
    const project = await new ProjectRepository(database).findById(ownerId, projectId);
    if (!project) throw new AssetApplicationError("ASSET_PROJECT_NOT_FOUND", "Project not found.");
    if (project.status !== "ACTIVE") {
      throw new AssetApplicationError("ASSET_PROJECT_ARCHIVED", "Archived projects are read-only.");
    }
  }

  private async signExisting(asset: Asset, input: PrepareAssetUploadInput) {
    const validated = validateUploadIntent({
      assetType: input.assetType,
      originalName: input.originalName,
      declaredContentType: input.contentType,
      declaredByteSize: input.byteSize,
    }, { maxUploadBytes: this.config.maxUploadBytes });
    if (
      asset.projectId !== input.projectId || asset.type !== input.assetType ||
      asset.originalName !== validated.sanitizedName || asset.contentType !== input.contentType ||
      asset.byteSize !== BigInt(input.byteSize)
    ) {
      throw new AssetApplicationError("ASSET_IDEMPOTENCY_CONFLICT", "Idempotency input changed.");
    }
    if (asset.status !== "PENDING_UPLOAD") {
      throw new AssetApplicationError("ASSET_INVALID_STATE", "Upload is no longer pending.");
    }
    if (!asset.uploadExpiresAt || asset.uploadExpiresAt.getTime() <= this.now().getTime()) {
      throw new AssetApplicationError("ASSET_UPLOAD_EXPIRED", "Upload request expired.");
    }
    return this.sign(asset);
  }

  private async sign(asset: Asset) {
    const remainingSeconds = Math.min(
      this.config.signedUrlTtlSeconds,
      Math.floor(((asset.uploadExpiresAt?.getTime() ?? this.now().getTime()) - this.now().getTime()) / 1_000),
    );
    if (remainingSeconds < 30) {
      throw new AssetApplicationError("ASSET_UPLOAD_EXPIRED", "Upload request expired.");
    }
    let uploadKey = asset.objectKey as StorageObjectKey;
    if (asset.storageLayout === "STAGED_IMMUTABLE_V1") {
      const staging = await new AssetStorageObjectRepository(this.database)
        .findByRole(asset.ownerId, asset.id, "STAGING");
      if (!staging || staging.state === "DELETED") {
        throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Staging identity is unavailable.");
      }
      uploadKey = staging.objectKey as StorageObjectKey;
    }
    const upload = await this.storage.createPresignedUpload({
      key: uploadKey,
      contentType: asset.contentType ?? "application/octet-stream",
      contentLength: Number(asset.byteSize ?? 0n),
      expiresInSeconds: remainingSeconds,
      metadata: { assetId: asset.id },
    });
    return { assetId: asset.id, status: asset.status, upload };
  }

  private assertObjectMetadata(
    asset: Asset,
    head: { contentLength: number; contentType: string | null; etag: string | null; metadata: Readonly<Record<string, string>> },
    input: CompleteAssetUploadInput,
  ) {
    if (head.contentLength !== Number(asset.byteSize) || head.contentLength > this.config.maxUploadBytes) {
      throw this.verificationFailure("OBJECT_SIZE_MISMATCH");
    }
    if (head.contentType !== asset.contentType) throw this.verificationFailure("OBJECT_MIME_MISMATCH");
    if (!normalizedEtag(head.etag)) throw this.verificationFailure("OBJECT_ETAG_MISSING");
    if (head.metadata["assetid"] !== asset.id && head.metadata["assetId"] !== asset.id) {
      throw this.verificationFailure("OBJECT_METADATA_MISMATCH");
    }
    if (input.etag && normalizedEtag(input.etag) !== normalizedEtag(head.etag)) {
      throw this.verificationFailure("OBJECT_ETAG_MISMATCH");
    }
  }

  private readyResult(asset: Asset, input: CompleteAssetUploadInput) {
    if (input.checksumSha256 && input.checksumSha256.toLowerCase() !== asset.checksumSha256) {
      throw new AssetApplicationError("ASSET_IDEMPOTENCY_CONFLICT", "Completion checksum changed.");
    }
    if (
      asset.storageLayout === "LEGACY_SINGLE_OBJECT" && input.etag &&
      normalizedEtag(input.etag) !== metadataEtag(asset)
    ) {
      throw new AssetApplicationError("ASSET_IDEMPOTENCY_CONFLICT", "Completion ETag changed.");
    }
    return toAssetResult(asset);
  }

  private verificationFailure(code: string, cause?: unknown) {
    return new AssetApplicationError(
      "ASSET_VERIFICATION_FAILED",
      `Asset verification failed (${code}).`,
      false,
      cause === undefined ? undefined : { cause },
    );
  }

  private isInvalidObject(error: unknown): boolean {
    return (
      error instanceof AssetApplicationError &&
      (error.code === "ASSET_VERIFICATION_FAILED" || error.code === "ASSET_INVALID_INPUT")
    ) || (error instanceof StorageError && error.code === "NOT_FOUND");
  }

  private rejectionCode(error: unknown): string {
    if (error instanceof StorageError && error.code === "NOT_FOUND") return "OBJECT_NOT_FOUND";
    if (error instanceof AssetApplicationError) {
      const match = /\(([^)]+)\)/.exec(error.message);
      return match?.[1]?.slice(0, 128) ?? "INVALID_IMAGE";
    }
    return "INVALID_IMAGE";
  }

  private async rejectVerification(ownerId: string, id: string, rejectionCode: string) {
    await this.database.$transaction(async (transaction) => {
      const result = await new AssetRepository(transaction).transition({
        ownerId,
        id,
        from: "VERIFYING",
        to: "REJECTED",
        verificationStartedAt: null,
        rejectionCode,
        integrityStatus: "FAILED",
      });
      if (result.count === 1) {
        await new ActivityLogRepository(transaction).create({
          ownerId,
          actorUserId: ownerId,
          action: "ASSET_UPLOAD_REJECTED",
          entityType: "ASSET",
          entityId: id,
          metadata: { rejectionCode },
        });
      }
    });
  }

  private async quarantineVerification(ownerId: string, id: string, rejectionCode: string) {
    await this.database.$transaction(async (transaction) => {
      const result = await new AssetRepository(transaction).transition({
        ownerId,
        id,
        from: "VERIFYING",
        to: "QUARANTINED",
        verificationStartedAt: null,
        rejectionCode,
        integrityStatus: "FAILED",
      });
      if (result.count === 1) {
        await new ActivityLogRepository(transaction).create({
          ownerId,
          actorUserId: ownerId,
          action: "ASSET_INTEGRITY_QUARANTINED",
          entityType: "ASSET",
          entityId: id,
          metadata: { rejectionCode },
        });
      }
    });
  }

  private async recoverVerification(ownerId: string, id: string, exhausted: boolean) {
    await this.database.$transaction(async (transaction) => {
      const result = await new AssetRepository(transaction).transition({
        ownerId,
        id,
        from: "VERIFYING",
        to: exhausted ? "QUARANTINED" : "PENDING_UPLOAD",
        verificationStartedAt: null,
        ...(exhausted
          ? { rejectionCode: "MAX_VERIFICATION_ATTEMPTS", integrityStatus: "FAILED" as const }
          : {}),
      });
      if (result.count === 1) {
        await new ActivityLogRepository(transaction).create({
          ownerId,
          actorUserId: ownerId,
          action: exhausted
            ? "ASSET_VERIFICATION_ATTEMPTS_EXHAUSTED"
            : "ASSET_VERIFICATION_RETRYABLE_FAILURE",
          entityType: "ASSET",
          entityId: id,
        });
      }
    });
  }
}
