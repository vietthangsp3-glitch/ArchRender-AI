import type {
  AssetIntegrityStatus,
  AssetStatus,
  AssetStorageLayout,
  AssetType,
  Prisma,
} from "../generated/prisma/client";
import type { DatabaseClient, OwnerScope } from "../types";

export interface CreateAssetRecord extends OwnerScope {
  id?: string;
  projectId?: string;
  type: AssetType;
  status?: AssetStatus;
  bucket: string;
  objectKey: string;
  originalName?: string;
  contentType?: string;
  byteSize?: bigint;
  width?: number;
  height?: number;
  checksumSha256?: string;
  uploadRequestId?: string;
  uploadExpiresAt?: Date;
  verificationStartedAt?: Date;
  verifiedAt?: Date;
  rejectionCode?: string;
  verificationAttempts?: number;
  storageLayout?: AssetStorageLayout;
  integrityStatus?: AssetIntegrityStatus;
  finalizedAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface FinalizeImmutableAssetRecord extends OwnerScope {
  id: string;
  contentType: string;
  byteSize: bigint;
  width: number;
  height: number;
  checksumSha256: string;
  finalizedAt: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface TransitionAssetRecord extends OwnerScope {
  id: string;
  from: AssetStatus;
  to: AssetStatus;
  uploadExpiresAt?: Date | null;
  verificationStartedAt?: Date | null;
  verifiedAt?: Date | null;
  rejectionCode?: string | null;
  byteSize?: bigint;
  width?: number;
  height?: number;
  checksumSha256?: string;
  contentType?: string;
  metadata?: Prisma.InputJsonValue;
  integrityStatus?: AssetIntegrityStatus;
  finalizedAt?: Date | null;
}

export interface ListAssetsRecord extends OwnerScope {
  projectId?: string;
  type?: AssetType;
  status?: AssetStatus;
  search?: string;
  sort: "newest" | "oldest" | "name" | "size";
  skip: number;
  take: number;
}

function assertCreateStateContract(
  status: AssetStatus,
  storageLayout: AssetStorageLayout,
  integrityStatus: AssetIntegrityStatus,
) {
  if (integrityStatus === "VERIFIED_IMMUTABLE") {
    throw new TypeError(
      "VERIFIED_IMMUTABLE assets must be promoted by finalizeImmutable().",
    );
  }

  const valid =
    (integrityStatus === "PENDING" &&
      (status === "PENDING_UPLOAD" || status === "VERIFYING")) ||
    (integrityStatus === "FAILED" &&
      (status === "REJECTED" || status === "QUARANTINED")) ||
    (integrityStatus === "LEGACY_GUARDED" &&
      storageLayout === "LEGACY_SINGLE_OBJECT" &&
      status === "READY");

  if (!valid) {
    throw new TypeError(
      "Asset create state violates the immutable storage contract.",
    );
  }
}

export class AssetRepository {
  constructor(private readonly database: DatabaseClient) {}

  create(input: CreateAssetRecord) {
    const {
      ownerId,
      projectId,
      status = "PENDING_UPLOAD",
      storageLayout = "LEGACY_SINGLE_OBJECT",
      integrityStatus = "PENDING",
      ...data
    } = input;
    assertCreateStateContract(status, storageLayout, integrityStatus);

    return this.database.asset.create({
      data: {
        ...data,
        status,
        storageLayout,
        integrityStatus,
        owner: { connect: { id: ownerId } },
        ...(projectId
          ? {
              project: {
                connect: { id_ownerId: { id: projectId, ownerId } },
              },
            }
          : {}),
      },
    });
  }

  findById(ownerId: string, id: string) {
    return this.database.asset.findUnique({
      where: { id_ownerId: { id, ownerId } },
    });
  }

  findVisibleById(ownerId: string, id: string) {
    return this.database.asset.findFirst({
      where: { id, ownerId, deletedAt: null, status: { not: "DELETED" } },
      include: {
        project: { select: { id: true, name: true, status: true } },
        _count: { select: { renderInputs: true, renderOutputs: true } },
      },
    });
  }

  findByUploadRequestId(ownerId: string, uploadRequestId: string) {
    return this.database.asset.findUnique({
      where: { ownerId_uploadRequestId: { ownerId, uploadRequestId } },
    });
  }

  transition(input: TransitionAssetRecord) {
    const { id, ownerId, from, to, ...data } = input;
    return this.database.asset.updateMany({
      where: { id, ownerId, status: from, deletedAt: null },
      data: {
        ...data,
        status: to,
        ...(to === "VERIFYING" ? { verificationAttempts: { increment: 1 } } : {}),
        ...(to === "DELETED" ? { deletedAt: new Date() } : {}),
      },
    });
  }

  finalizeImmutable(input: FinalizeImmutableAssetRecord) {
    const { id, ownerId, ...data } = input;
    return this.database.asset.updateMany({
      where: {
        id,
        ownerId,
        status: "VERIFYING",
        storageLayout: "STAGED_IMMUTABLE_V1",
        integrityStatus: "PENDING",
        deletedAt: null,
      },
      data: {
        ...data,
        status: "READY",
        integrityStatus: "VERIFIED_IMMUTABLE",
        verifiedAt: data.finalizedAt,
        verificationStartedAt: null,
        rejectionCode: null,
      },
    });
  }

  countRecentInitiated(ownerId: string, since: Date) {
    return this.database.asset.count({ where: { ownerId, createdAt: { gte: since } } });
  }

  countConcurrentUploads(ownerId: string, now = new Date()) {
    return this.database.asset.count({
      where: {
        ownerId,
        deletedAt: null,
        OR: [
          { status: "VERIFYING" },
          {
            status: "PENDING_UPLOAD",
            OR: [
              { uploadExpiresAt: null },
              { uploadExpiresAt: { gt: now } },
            ],
          },
        ],
      },
    });
  }

  async reservedBytes(ownerId: string): Promise<bigint> {
    const [assets, derivatives] = await Promise.all([
      this.database.asset.aggregate({
        where: {
          ownerId,
          status: { in: ["PENDING_UPLOAD", "VERIFYING", "READY"] },
          deletedAt: null,
        },
        _sum: { byteSize: true },
      }),
      this.database.assetStorageObject.aggregate({
        where: {
          ownerId,
          role: { in: ["THUMBNAIL_GRID", "THUMBNAIL_DETAIL"] },
          state: "VERIFIED",
          deletedAt: null,
        },
        _sum: { byteSize: true },
      }),
    ]);
    return (assets._sum.byteSize ?? 0n) + (derivatives._sum.byteSize ?? 0n);
  }

  countReferences(ownerId: string, id: string) {
    return this.database.asset.findUnique({
      where: { id_ownerId: { id, ownerId } },
      select: { _count: { select: { renderInputs: true, renderOutputs: true } } },
    });
  }

  async listPage(input: ListAssetsRecord) {
    const where: Prisma.AssetWhereInput = {
      ownerId: input.ownerId,
      deletedAt: null,
      status: input.status ?? { not: "DELETED" },
      ...(input.status === "READY"
        ? { integrityStatus: { in: ["VERIFIED_IMMUTABLE", "LEGACY_GUARDED"] } }
        : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.search
        ? { originalName: { contains: input.search, mode: "insensitive" } }
        : {}),
    };
    const primaryOrder: Prisma.AssetOrderByWithRelationInput =
      input.sort === "oldest" ? { createdAt: "asc" }
        : input.sort === "name" ? { originalName: "asc" }
          : input.sort === "size" ? { byteSize: "desc" }
            : { createdAt: "desc" };
    const [items, total] = await Promise.all([
      this.database.asset.findMany({
        where,
        orderBy: [primaryOrder, { id: input.sort === "oldest" ? "asc" : "desc" }],
        skip: input.skip,
        take: input.take,
        include: { project: { select: { id: true, name: true, status: true } } },
      }),
      this.database.asset.count({ where }),
    ]);
    return { items, total };
  }

  requestDeletion(ownerId: string, id: string) {
    return this.database.asset.updateMany({
      where: { id, ownerId, status: { not: "DELETED" }, deletedAt: null },
      data: { status: "DELETED" },
    });
  }

  listCleanupCandidates(now: Date, staleVerificationBefore: Date, take: number, ownerId?: string) {
    return this.database.asset.findMany({
      where: {
        ...(ownerId ? { ownerId } : {}),
        deletedAt: null,
        OR: [
          { status: "DELETED" },
          { status: "PENDING_UPLOAD", uploadExpiresAt: { lte: now } },
          { status: "REJECTED" },
          { status: "QUARANTINED" },
          { status: "VERIFYING", verificationStartedAt: { lte: staleVerificationBefore } },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: Math.min(Math.max(take, 1), 500),
    });
  }

  listForProject(ownerId: string, projectId: string, type?: AssetType) {
    return this.database.asset.findMany({
      where: {
        ownerId,
        projectId,
        deletedAt: null,
        ...(type ? { type } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  markDeleted(ownerId: string, id: string, deletedAt = new Date()) {
    return this.database.asset.update({
      where: { id_ownerId: { id, ownerId } },
      data: { status: "DELETED", deletedAt },
    });
  }
}
