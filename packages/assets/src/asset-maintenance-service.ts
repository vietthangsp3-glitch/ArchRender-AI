import {
  ActivityLogRepository,
  type Asset,
  AssetRepository,
  type AssetStorageObject,
  AssetStorageObjectRepository,
  type PrismaClient,
} from "@archrender/database";

import type { AssetStorageConfig } from "./config";
import { AssetApplicationError, StorageError } from "./errors";
import type { StorageProvider } from "./storage-provider";
import type { StorageObjectKey } from "./types";

export interface MaintenanceResult {
  scanned: number;
  plannedDeletes: number;
  plannedRecoveries: number;
  deleted: number;
  recovered: number;
  skippedReferenced: number;
  failed: number;
}

export interface MaintenanceOptions {
  limit?: number;
  dryRun?: boolean;
  confirmedEnvironment?: AssetStorageConfig["environment"];
}

export class AssetMaintenanceService {
  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageProvider,
    private readonly config: AssetStorageConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const dryRun = options.dryRun ?? true;
    if (!dryRun && options.confirmedEnvironment !== this.config.environment) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Maintenance environment confirmation mismatch.");
    }
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.config.verificationStaleSeconds * 1_000);
    const assets = new AssetRepository(this.database);
    const candidates = await assets.listCleanupCandidates(now, staleBefore, limit);
    const result: MaintenanceResult = {
      scanned: candidates.length,
      plannedDeletes: 0,
      plannedRecoveries: 0,
      deleted: 0,
      recovered: 0,
      skippedReferenced: 0,
      failed: 0,
    };

    for (const asset of candidates) {
      if (asset.status === "VERIFYING") {
        result.plannedRecoveries += 1;
        if (dryRun) continue;
        const recovered = await this.database.$transaction(async (transaction) => {
          const transition = await new AssetRepository(transaction).transition({
            ownerId: asset.ownerId,
            id: asset.id,
            from: "VERIFYING",
            to: "PENDING_UPLOAD",
            verificationStartedAt: null,
          });
          if (transition.count === 1) {
            await new ActivityLogRepository(transaction).create({
              ownerId: asset.ownerId,
              action: "ASSET_VERIFICATION_RECLAIMED",
              entityType: "ASSET",
              entityId: asset.id,
            });
          }
          return transition;
        });
        result.recovered += recovered.count;
        continue;
      }

      const references = await assets.countReferences(asset.ownerId, asset.id);
      const referenceCount = (references?._count.renderInputs ?? 0) + (references?._count.renderOutputs ?? 0);
      if (referenceCount > 0) {
        result.skippedReferenced += 1;
        continue;
      }
      result.plannedDeletes += 1;
      if (dryRun) continue;
      try {
        const storageObjects = asset.storageLayout === "STAGED_IMMUTABLE_V1"
          ? await new AssetStorageObjectRepository(this.database).listForAsset(
              asset.ownerId,
              asset.id,
            )
          : [];
        if (asset.storageLayout === "STAGED_IMMUTABLE_V1" && storageObjects.length === 0) {
          throw new AssetApplicationError(
            "ASSET_INTEGRITY_CONFLICT",
            "Asset storage identity is incomplete.",
          );
        }
        if (storageObjects.some((object) => object.nextAttemptAt && object.nextAttemptAt > now)) {
          result.plannedDeletes -= 1;
          continue;
        }
        const deletionTargets = storageObjects.length > 0
          ? this.orderDeletionTargets(storageObjects)
          : [{
              id: null,
              ownerId: asset.ownerId,
              assetId: asset.id,
              bucket: asset.bucket,
              objectKey: asset.objectKey,
              role: "LEGACY" as const,
            }];

        for (const object of deletionTargets) {
          this.assertControlledObject(asset, object);
          try {
            await this.storage.deleteObject(object.objectKey as StorageObjectKey);
          } catch (error) {
            if (!(error instanceof StorageError && error.code === "NOT_FOUND")) throw error;
          }
        }
        const deleted = await this.database.$transaction(async (transaction) => {
          const deletedAt = this.now();
          const transactionStorageObjects = new AssetStorageObjectRepository(transaction);
          for (const object of storageObjects) {
            const marked = await transactionStorageObjects.markDeleted(
              asset.ownerId,
              object.id,
              deletedAt,
            );
            if (marked.count !== 1) {
              throw new AssetApplicationError(
                "ASSET_INTEGRITY_CONFLICT",
                "Asset storage identity changed during cleanup.",
              );
            }
          }
          const transition = await new AssetRepository(transaction).transition({
            ownerId: asset.ownerId,
            id: asset.id,
            from: asset.status,
            to: "DELETED",
          });
          if (transition.count === 1) {
            await new ActivityLogRepository(transaction).create({
              ownerId: asset.ownerId,
              action: "ASSET_OBJECT_CLEANED",
              entityType: "ASSET",
              entityId: asset.id,
            });
          }
          return transition.count;
        });
        result.deleted += deleted;
      } catch (error) {
        const errorCode = error instanceof StorageError ? error.code : "MAINTENANCE_FAILED";
        const retryAt = new Date(this.now().getTime() + Math.min(3_600_000, 5_000 * 2 ** Math.min(asset.verificationAttempts, 8)));
        const objects = await new AssetStorageObjectRepository(this.database).listForAsset(asset.ownerId, asset.id);
        await Promise.all(objects.map((object) =>
          new AssetStorageObjectRepository(this.database).recordAttempt(asset.ownerId, object.id, errorCode, retryAt)
        ));
        result.failed += 1;
      }
    }
    return result;
  }

  private orderDeletionTargets(objects: AssetStorageObject[]) {
    const priority: Record<AssetStorageObject["role"], number> = {
      THUMBNAIL_GRID: 0,
      THUMBNAIL_DETAIL: 0,
      STAGING: 1,
      ORIGINAL: 2,
    };
    return [...objects].sort((left, right) => priority[left.role] - priority[right.role]);
  }

  private assertControlledObject(
    asset: Asset,
    object: Pick<AssetStorageObject, "assetId" | "ownerId" | "bucket" | "objectKey" | "role"> |
      {
        assetId: string;
        ownerId: string;
        bucket: string;
        objectKey: string;
        role: "LEGACY";
      },
  ) {
    if (
      !asset.projectId ||
      asset.bucket !== this.config.bucket ||
      object.bucket !== this.config.bucket ||
      object.assetId !== asset.id ||
      object.ownerId !== asset.ownerId
    ) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Asset storage identity mismatch.");
    }
    const expectedPrefix = `${this.config.environment}/owners/${asset.ownerId}/projects/` +
      `${asset.projectId}/assets/${asset.id}/`;
    const suffix = object.objectKey.startsWith(expectedPrefix)
      ? object.objectKey.slice(expectedPrefix.length)
      : "";
    const expectedSuffix = object.role === "LEGACY"
      ? /^[a-f0-9]{32}$/i
      : object.role === "STAGING"
        ? /^staging\/[a-f0-9]{32}$/i
        : object.role === "ORIGINAL"
          ? /^original\/[a-f0-9]{32}$/i
          : object.role === "THUMBNAIL_GRID"
            ? /^derivatives\/grid\/[a-f0-9]{32}$/i
            : /^derivatives\/detail\/[a-f0-9]{32}$/i;
    if (!expectedSuffix.test(suffix)) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Asset object key is not controlled.");
    }
  }
}
