import type {
  AssetStorageObjectRole,
  AssetStorageObjectState,
} from "../generated/prisma/client";
import type { DatabaseClient, OwnerScope } from "../types";

export interface CreateAssetStorageObjectRecord extends OwnerScope {
  assetId: string;
  role: AssetStorageObjectRole;
  state?: AssetStorageObjectState;
  bucket: string;
  objectKey: string;
  contentType?: string;
  byteSize?: bigint;
  uploadExpiresAt?: Date;
  cleanupAfter?: Date;
}

export interface ReserveDerivativeRecord extends CreateAssetStorageObjectRecord {
  role: "THUMBNAIL_GRID" | "THUMBNAIL_DETAIL";
  sourceObjectId?: string;
}

export interface VerifyAssetStorageObjectRecord extends OwnerScope {
  id: string;
  state: AssetStorageObjectState;
  contentType: string;
  byteSize: bigint;
  width?: number;
  height?: number;
  checksumSha256: string;
  storageEtag: string;
  immutableAt?: Date;
  cleanupAfter?: Date;
}

export class AssetStorageObjectRepository {
  constructor(private readonly database: DatabaseClient) {}

  create(input: CreateAssetStorageObjectRecord) {
    const { ownerId, assetId, ...data } = input;
    return this.database.assetStorageObject.create({
      data: {
        ...data,
        asset: { connect: { id_ownerId: { id: assetId, ownerId } } },
      },
    });
  }

  reserveDerivative(input: ReserveDerivativeRecord) {
    const { ownerId, assetId, sourceObjectId, ...data } = input;
    return this.database.assetStorageObject.upsert({
      where: { assetId_role: { assetId, role: data.role } },
      create: {
        ...data,
        state: "RESERVED",
        asset: { connect: { id_ownerId: { id: assetId, ownerId } } },
        ...(sourceObjectId
          ? { source: { connect: { id_assetId_ownerId: { id: sourceObjectId, assetId, ownerId } } } }
          : {}),
      },
      update: {},
    });
  }

  findByRole(ownerId: string, assetId: string, role: AssetStorageObjectRole) {
    return this.database.assetStorageObject.findFirst({
      where: { ownerId, assetId, role, deletedAt: null },
    });
  }

  listForAsset(ownerId: string, assetId: string) {
    return this.database.assetStorageObject.findMany({
      where: { ownerId, assetId, deletedAt: null },
      orderBy: [{ role: "asc" }, { id: "asc" }],
    });
  }

  markVerified(input: VerifyAssetStorageObjectRecord) {
    const { id, ownerId, ...data } = input;
    return this.database.assetStorageObject.updateMany({
      where: { id, ownerId, deletedAt: null },
      data: { ...data, lastErrorCode: null, nextAttemptAt: null },
    });
  }

  recordAttempt(ownerId: string, id: string, errorCode: string, nextAttemptAt?: Date) {
    return this.database.assetStorageObject.updateMany({
      where: { id, ownerId, deletedAt: null },
      data: {
        attempts: { increment: 1 },
        lastErrorCode: errorCode,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
      },
    });
  }

  markDeleted(ownerId: string, id: string, deletedAt: Date) {
    return this.database.assetStorageObject.updateMany({
      where: { id, ownerId, deletedAt: null },
      data: {
        state: "DELETED",
        deletedAt,
        cleanupAfter: null,
        nextAttemptAt: null,
        lastErrorCode: null,
      },
    });
  }
}
