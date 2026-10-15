import type {
  Prisma,
  RenderJobEventType,
  RenderJobStatus,
  RenderJobType,
} from "../generated/prisma/client";
import type { DatabaseClient, OwnerScope } from "../types";

export interface CreateRenderJobRecord extends OwnerScope {
  projectId: string;
  workflowVersionId?: string;
  type: RenderJobType;
  idempotencyKey: string;
  parameters: Prisma.InputJsonValue;
  inputSnapshot?: Prisma.InputJsonValue;
  requestedWidth?: number;
  requestedHeight?: number;
  requestedResolution?: string;
}

export interface AppendRenderJobEventRecord extends OwnerScope {
  jobId: string;
  sequence: number;
  type: RenderJobEventType;
  fromStatus?: RenderJobStatus;
  toStatus?: RenderJobStatus;
  progress?: Prisma.Decimal | number | string;
  message?: string;
  metadata?: Prisma.InputJsonValue;
}

export class RenderJobRepository {
  constructor(private readonly database: DatabaseClient) {}

  create(input: CreateRenderJobRecord) {
    const { ownerId, projectId, workflowVersionId, inputSnapshot, ...data } = input;
    return this.database.renderJob.create({
      data: {
        ...data,
        inputSnapshot: inputSnapshot ?? [],
        owner: { connect: { id: ownerId } },
        project: {
          connect: { id_ownerId: { id: projectId, ownerId } },
        },
        ...(workflowVersionId
          ? {
              workflowVersion: {
                connect: {
                  id_ownerId: { id: workflowVersionId, ownerId },
                },
              },
            }
          : {}),
      },
    });
  }

  findById(ownerId: string, id: string) {
    return this.database.renderJob.findUnique({
      where: { id_ownerId: { id, ownerId } },
      include: {
        inputs: { include: { asset: true }, orderBy: { position: "asc" } },
        outputs: { include: { asset: true }, orderBy: { position: "asc" } },
      },
    });
  }

  findByIdempotencyKey(ownerId: string, idempotencyKey: string) {
    return this.database.renderJob.findUnique({
      where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
    });
  }

  list(ownerId: string, status?: RenderJobStatus) {
    return this.database.renderJob.findMany({
      where: { ownerId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  appendEvent(input: AppendRenderJobEventRecord) {
    return this.database.renderJobEvent.create({ data: input });
  }
}
