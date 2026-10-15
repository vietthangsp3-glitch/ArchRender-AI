import { createHash, randomUUID } from "node:crypto";

import {
  ActivityLogRepository,
  AssetRepository,
  AssetStorageObjectRepository,
  Prisma,
  type PrismaClient,
} from "@archrender/database";
import { z } from "zod";

import type { AssetStorageConfig } from "./config";
import { AssetApplicationError } from "./errors";
import { ImmutableObjectFinalizer } from "./immutable-object-finalizer";
import { createFinalObjectKey } from "./object-key";
import type { StorageProvider } from "./storage-provider";
import type { StorageObjectKey } from "./types";

const commitSchema = z.object({
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
  generation: z.number().int().min(1).max(1_000_000),
  leaseToken: z.string().min(32).max(256),
  role: z.enum(["GENERATED_IMAGE", "GENERATED_VIDEO"]),
  position: z.number().int().min(0).max(7),
  filename: z.string().regex(/^[A-Za-z0-9_.-]{1,180}$/),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4"]),
  bytes: z.instanceof(Uint8Array),
}).strict();

export interface GeneratedMediaInspection {
  contentType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  width: number;
  height: number;
  byteSize: number;
  checksumSha256: string;
  durationSeconds?: number;
}

export interface GeneratedMediaInspector {
  inspect(bytes: Uint8Array, declaredContentType: string): Promise<GeneratedMediaInspection>;
}

function hashLeaseToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createGeneratedOutputRequestId(input: {
  jobId: string;
  role: "GENERATED_IMAGE" | "GENERATED_VIDEO";
  position: number;
}) {
  return `job-output:${input.jobId}:${input.role}:${input.position}`;
}

export class GeneratedOutputService {
  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageProvider,
    private readonly config: AssetStorageConfig,
    private readonly inspector: GeneratedMediaInspector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async commit(input: unknown) {
    const parsed = commitSchema.parse(input);
    if (parsed.bytes.byteLength < 1 || parsed.bytes.byteLength > this.config.maxUploadBytes) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Generated output exceeds its bounded size.");
    }
    const inspection = await this.inspector.inspect(parsed.bytes, parsed.contentType);
    const checksumSha256 = createHash("sha256").update(parsed.bytes).digest("hex");
    if (
      inspection.byteSize !== parsed.bytes.byteLength || inspection.contentType !== parsed.contentType ||
      inspection.checksumSha256 !== checksumSha256 || inspection.width < 1 || inspection.height < 1
    ) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Generated output inspection is inconsistent.");
    }
    if ((parsed.role === "GENERATED_VIDEO") !== (parsed.contentType === "video/mp4")) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Generated output role and media type do not match.");
    }

    // Deliberately stable across worker generations: a lease crash after final PUT
    // must recover and verify the same reserved object instead of allocating a new key.
    const requestId = createGeneratedOutputRequestId(parsed);
    const reservation = await this.reserve(parsed, requestId, inspection);
    if (reservation.ready) return reservation.ready;

    const identity = await new ImmutableObjectFinalizer(this.storage, this.config.maxUploadBytes).finalize({
      assetId: reservation.asset.id,
      finalKey: reservation.original.objectKey as StorageObjectKey,
      bytes: parsed.bytes,
      contentType: inspection.contentType,
      checksumSha256,
      role: "generated-output",
    });

    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const job = await transaction.renderJob.findUnique({ where: { id_ownerId: { id: parsed.jobId, ownerId: parsed.ownerId } } });
      if (!job || job.projectId !== parsed.projectId || job.executionGeneration !== parsed.generation ||
          job.leaseTokenHash !== hashLeaseToken(parsed.leaseToken) || !job.leaseExpiresAt || job.leaseExpiresAt <= this.now() ||
          job.status !== "RUNNING") {
        throw new AssetApplicationError("ASSET_INVALID_STATE", "Worker lease is stale; output commit rejected.");
      }
      const existing = await transaction.renderJobOutput.findUnique({
        where: { jobId_role_position: { jobId: parsed.jobId, role: parsed.role, position: parsed.position } },
        include: { asset: true },
      });
      if (existing) return this.assertExisting(existing.asset, checksumSha256);
      const currentAsset = await transaction.asset.findUnique({ where: { id_ownerId: { id: reservation.asset.id, ownerId: parsed.ownerId } } });
      if (!currentAsset) throw new AssetApplicationError("ASSET_NOT_FOUND", "Generated asset reservation is unavailable.");
      if (currentAsset.status !== "READY") {
        const storageObjects = new AssetStorageObjectRepository(transaction);
        const originalUpdated = await storageObjects.markVerified({
          ownerId: parsed.ownerId,
          id: reservation.original.id,
          state: "VERIFIED",
          contentType: inspection.contentType,
          byteSize: BigInt(inspection.byteSize),
          width: inspection.width,
          height: inspection.height,
          checksumSha256,
          storageEtag: identity.etag,
          immutableAt: this.now(),
        });
        if (originalUpdated.count !== 1) throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Generated object identity changed.");
        const finalized = await new AssetRepository(transaction).finalizeImmutable({
          ownerId: parsed.ownerId,
          id: reservation.asset.id,
          contentType: inspection.contentType,
          byteSize: BigInt(inspection.byteSize),
          width: inspection.width,
          height: inspection.height,
          checksumSha256,
          finalizedAt: this.now(),
          metadata: {
            storageEtag: identity.etag,
            immutableStorageObjectId: reservation.original.id,
            renderJobId: parsed.jobId,
            outputRole: parsed.role,
            outputPosition: parsed.position,
            ...(inspection.durationSeconds === undefined ? {} : { durationSeconds: inspection.durationSeconds }),
          },
        });
        if (finalized.count !== 1) throw new AssetApplicationError("ASSET_INVALID_STATE", "Generated asset finalization claim was lost.");
      } else if (currentAsset.checksumSha256 !== checksumSha256 || currentAsset.integrityStatus !== "VERIFIED_IMMUTABLE") {
        throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Recovered generated asset identity does not match.");
      }
      await transaction.renderJobOutput.create({
        data: { jobId: parsed.jobId, assetId: reservation.asset.id, ownerId: parsed.ownerId, role: parsed.role, position: parsed.position },
      });
      await new ActivityLogRepository(transaction).create({
        ownerId: parsed.ownerId,
        actorUserId: parsed.ownerId,
        action: "RENDER_OUTPUT_IMMUTABLE_COMMITTED",
        entityType: "ASSET",
        entityId: reservation.asset.id,
        metadata: { jobId: parsed.jobId, role: parsed.role, position: parsed.position },
      });
      return transaction.asset.findUniqueOrThrow({ where: { id_ownerId: { id: reservation.asset.id, ownerId: parsed.ownerId } } });
    });
  }

  private async reserve(
    parsed: z.infer<typeof commitSchema>,
    requestId: string,
    inspection: GeneratedMediaInspection,
  ) {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const job = await transaction.renderJob.findUnique({ where: { id_ownerId: { id: parsed.jobId, ownerId: parsed.ownerId } } });
      if (!job || job.projectId !== parsed.projectId || job.executionGeneration !== parsed.generation ||
          job.leaseTokenHash !== hashLeaseToken(parsed.leaseToken) || !job.leaseExpiresAt || job.leaseExpiresAt <= this.now() || job.status !== "RUNNING") {
        throw new AssetApplicationError("ASSET_INVALID_STATE", "Worker lease is stale; output reservation rejected.");
      }
      const mapped = await transaction.renderJobOutput.findUnique({
        where: { jobId_role_position: { jobId: parsed.jobId, role: parsed.role, position: parsed.position } }, include: { asset: true },
      });
      if (mapped) return { ready: this.assertExisting(mapped.asset, inspection.checksumSha256) } as const;
      const assets = new AssetRepository(transaction);
      let asset = await assets.findByUploadRequestId(parsed.ownerId, requestId);
      let original;
      if (!asset) {
        const assetId = randomUUID();
        const objectKey = createFinalObjectKey({ environment: this.config.environment, ownerId: parsed.ownerId, projectId: parsed.projectId, assetId });
        asset = await assets.create({
          id: assetId,
          ownerId: parsed.ownerId,
          projectId: parsed.projectId,
          type: parsed.role,
          status: "VERIFYING",
          bucket: this.config.bucket,
          objectKey,
          originalName: parsed.filename,
          contentType: inspection.contentType,
          byteSize: BigInt(inspection.byteSize),
          uploadRequestId: requestId,
          verificationStartedAt: this.now(),
          storageLayout: "STAGED_IMMUTABLE_V1",
          integrityStatus: "PENDING",
          metadata: { renderJobId: parsed.jobId, outputRole: parsed.role, outputPosition: parsed.position },
        });
        original = await new AssetStorageObjectRepository(transaction).create({
          ownerId: parsed.ownerId,
          assetId,
          role: "ORIGINAL",
          state: "RESERVED",
          bucket: this.config.bucket,
          objectKey,
        });
      } else {
        original = await new AssetStorageObjectRepository(transaction).findByRole(parsed.ownerId, asset.id, "ORIGINAL");
        if (!original) throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Generated output recovery identity is incomplete.");
      }
      return { asset, original, ready: null } as const;
    });
  }

  private assertExisting(asset: { checksumSha256: string | null; integrityStatus: string; status: string }, checksum: string) {
    if (asset.status !== "READY" || asset.integrityStatus !== "VERIFIED_IMMUTABLE" || asset.checksumSha256 !== checksum) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Existing generated output does not match retry.");
    }
    return asset;
  }
}
