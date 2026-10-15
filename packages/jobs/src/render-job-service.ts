import { requireRole, type AuthenticatedPrincipal } from "@archrender/auth";
import { Prisma, type PrismaClient, type RenderJobStatus } from "@archrender/database";

import { JobApplicationError } from "./errors";
import { idSchema, listJobsSchema, submitJobSchema, validateJobParameters, workflowConfigurationSchema } from "./schemas";

const activeStatuses: RenderJobStatus[] = [
  "QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED",
];

function publicJob<T extends object>(job: T): Omit<T, "leaseTokenHash"> {
  const { leaseTokenHash: _leaseTokenHash, ...safe } = job as T & { leaseTokenHash?: string | null };
  return safe as Omit<T, "leaseTokenHash">;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class RenderJobService {
  constructor(private readonly database: PrismaClient) {}

  async submit(principal: AuthenticatedPrincipal, input: unknown) {
    requireRole(principal, ["OWNER"]);
    const parsed = submitJobSchema.parse(input);
    const parameters = validateJobParameters(parsed.type, parsed.parameters);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${principal.id}, 1))`,
      );
      const existing = await transaction.renderJob.findUnique({
        where: { ownerId_idempotencyKey: { ownerId: principal.id, idempotencyKey: parsed.idempotencyKey } },
      });
      if (existing) {
        const requestedInputs = parsed.inputs.map(({ assetId, role, position }) => ({ assetId, role, position }));
        const storedInputs = Array.isArray(existing.inputSnapshot) ? existing.inputSnapshot.map((value) => {
          const item = value as { assetId?: unknown; role?: unknown; position?: unknown };
          return { assetId: item.assetId, role: item.role, position: item.position };
        }) : null;
        if (existing.projectId !== parsed.projectId || existing.type !== parsed.type || existing.workflowVersionId !== parsed.workflowVersionId ||
          stableJson(existing.parameters) !== stableJson(parameters) || stableJson(storedInputs) !== stableJson(requestedInputs)) {
          throw new JobApplicationError("JOB_IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another request.");
        }
        return publicJob(existing);
      }
      const project = await transaction.project.findUnique({
        where: { id_ownerId: { id: parsed.projectId, ownerId: principal.id } },
      });
      if (!project) throw new JobApplicationError("JOB_PROJECT_NOT_FOUND", "Project not found.");
      if (project.status !== "ACTIVE") throw new JobApplicationError("JOB_PROJECT_ARCHIVED", "Project is archived.");
      const workflow = await transaction.workflowVersion.findUnique({
        where: { id_ownerId: { id: parsed.workflowVersionId, ownerId: principal.id } },
        include: { preset: true },
      });
      if (!workflow || workflow.preset.status !== "PUBLISHED" || workflow.preset.kind !== parsed.type) {
        throw new JobApplicationError("JOB_WORKFLOW_INVALID", "Published workflow version is unavailable.");
      }
      const workflowConfiguration = workflowConfigurationSchema.safeParse(workflow.parameters);
      if (workflow.parameterSchemaVersion !== "1" || !workflowConfiguration.success || workflowConfiguration.data.kind !== parsed.type) {
        throw new JobApplicationError("JOB_WORKFLOW_INVALID", "Unsupported workflow schema version.");
      }
      const assetIds = [...new Set(parsed.inputs.map((item) => item.assetId))];
      if (assetIds.length !== parsed.inputs.length) {
        throw new JobApplicationError("JOB_ASSET_INVALID", "Duplicate input asset.");
      }
      const assets = await transaction.asset.findMany({
        where: {
          id: { in: assetIds }, ownerId: principal.id, projectId: parsed.projectId,
          status: "READY", integrityStatus: "VERIFIED_IMMUTABLE", deletedAt: null,
        },
        include: { storageObjects: { where: { role: "ORIGINAL", state: "VERIFIED", deletedAt: null } } },
      });
      if (assets.length !== assetIds.length || assets.some((asset) =>
        !asset.checksumSha256 || asset.storageObjects.length !== 1 ||
        !asset.storageObjects[0]?.checksumSha256 || !asset.storageObjects[0]?.storageEtag ||
        asset.storageObjects[0]?.checksumSha256 !== asset.checksumSha256 ||
        !asset.storageObjects[0]?.contentType?.startsWith("image/"))) {
        throw new JobApplicationError("JOB_ASSET_INVALID", "Every input must be a verified immutable original.");
      }
      const [recent, active] = await Promise.all([
        transaction.renderJob.count({ where: { ownerId: principal.id, createdAt: { gte: new Date(Date.now() - 60_000) } } }),
        transaction.renderJob.count({ where: { ownerId: principal.id, status: { in: activeStatuses } } }),
      ]);
      if (recent >= 10) throw new JobApplicationError("JOB_RATE_LIMITED", "Submission rate exceeded.", true);
      if (active >= 20) throw new JobApplicationError("JOB_QUEUE_LIMIT", "Active job limit exceeded.", true);
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      const imageTypes = new Set(["SOURCE_IMAGE", "REFERENCE_IMAGE", "SOURCE_RENDER", "GENERATED_IMAGE"]);
      if (parsed.inputs.some((item) => {
        const asset = byId.get(item.assetId)!;
        return item.role === "CONTROL_IMAGE"
          ? !["DEPTH_MAP", "NORMAL_MAP", "CANNY_MAP"].includes(asset.type)
          : !imageTypes.has(asset.type);
      })) throw new JobApplicationError("JOB_ASSET_INVALID", "Input asset type does not match its render role.");
      const snapshot = parsed.inputs.map((item) => {
        const asset = byId.get(item.assetId)!;
        const object = asset.storageObjects[0]!;
        return {
          assetId: asset.id,
          role: item.role,
          position: item.position,
          storageObjectId: object.id,
          checksumSha256: object.checksumSha256!,
          storageEtag: object.storageEtag!,
          contentType: object.contentType!,
        };
      });
      const job = await transaction.renderJob.create({
        data: {
          ownerId: principal.id,
          projectId: parsed.projectId,
          workflowVersionId: parsed.workflowVersionId,
          type: parsed.type,
          status: "QUEUED",
          priority: parsed.priority,
          progress: 0,
          idempotencyKey: parsed.idempotencyKey,
          parameters,
          inputSnapshot: snapshot,
          maxRetries: parsed.maxRetries,
          queuedAt: new Date(),
        },
      });
      await transaction.renderJobInput.createMany({
        data: snapshot.map((item) => ({ ...item, jobId: job.id, ownerId: principal.id })),
      });
      await transaction.renderJobEvent.create({
        data: {
          jobId: job.id, ownerId: principal.id, sequence: 1, type: "STATUS_CHANGED",
          fromStatus: "CREATED", toStatus: "QUEUED", message: "Job queued.",
        },
      });
      return publicJob(job);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async list(principal: AuthenticatedPrincipal, input: unknown) {
    requireRole(principal, ["OWNER"]);
    const query = listJobsSchema.parse(input);
    const where: Prisma.RenderJobWhereInput = {
      ownerId: principal.id,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { project: { name: { contains: query.search, mode: "insensitive" } } } : {}),
    };
    const [items, total] = await Promise.all([
      this.database.renderJob.findMany({
        where,
        select: {
          id: true, projectId: true, type: true, status: true, progress: true, priority: true,
          retryCount: true, maxRetries: true, errorCode: true, createdAt: true, updatedAt: true,
          project: { select: { id: true, name: true } },
          workflowVersion: { select: { id: true, version: true, preset: { select: { name: true } } } },
        },
        orderBy: [{ createdAt: query.sort === "newest" ? "desc" : "asc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.database.renderJob.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async summary(principal: AuthenticatedPrincipal, projectId?: string) {
    requireRole(principal, ["OWNER"]);
    const where: Prisma.RenderJobWhereInput = { ownerId: principal.id, ...(projectId ? { projectId } : {}) };
    const [groups, total, recent] = await Promise.all([
      this.database.renderJob.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.database.renderJob.count({ where }),
      this.database.renderJob.findMany({
        where,
        select: { id: true, status: true, type: true, progress: true, createdAt: true, project: { select: { name: true } }, workflowVersion: { select: { version: true, preset: { select: { name: true } } } } },
        orderBy: { createdAt: "desc" }, take: 6,
      }),
    ]);
    const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
    return {
      total,
      queued: (counts.QUEUED ?? 0) + (counts.RETRY_SCHEDULED ?? 0),
      running: (counts.CLAIMED ?? 0) + (counts.PROVISIONING ?? 0) + (counts.RUNNING ?? 0) + (counts.CANCEL_REQUESTED ?? 0),
      succeeded: counts.SUCCEEDED ?? 0,
      failed: counts.FAILED ?? 0,
      recent: recent.map((job) => ({ ...job, progress: Number(job.progress) })),
    };
  }

  async get(principal: AuthenticatedPrincipal, jobId: string) {
    requireRole(principal, ["OWNER"]);
    const id = idSchema.parse(jobId);
    const job = await this.database.renderJob.findUnique({
      where: { id_ownerId: { id, ownerId: principal.id } },
      include: {
        project: { select: { id: true, name: true } },
        workflowVersion: { include: { preset: { select: { id: true, name: true, kind: true } } } },
        inputs: { include: { asset: { select: { id: true, originalName: true, type: true } } }, orderBy: { position: "asc" } },
        outputs: {
          include: {
            asset: {
              select: {
                id: true, originalName: true, type: true, contentType: true,
                width: true, height: true, checksumSha256: true, status: true, integrityStatus: true,
              },
            },
          },
          orderBy: { position: "asc" },
        },
        attempts: {
          select: {
            id: true,
            attemptNumber: true,
            generation: true,
            status: true,
            startedAt: true,
            lastHeartbeatAt: true,
            finishedAt: true,
            errorCode: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { attemptNumber: "desc" },
          take: 20,
        },
        events: { orderBy: { sequence: "asc" }, take: 200 },
      },
    });
    if (!job) throw new JobApplicationError("JOB_NOT_FOUND", "Job not found.");
    return publicJob(job);
  }

  async events(principal: AuthenticatedPrincipal, jobId: string) {
    const job = await this.get(principal, jobId);
    return job.events;
  }

  async cancel(principal: AuthenticatedPrincipal, jobId: string) {
    requireRole(principal, ["OWNER"]);
    const id = idSchema.parse(jobId);
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.renderJob.findUnique({ where: { id_ownerId: { id, ownerId: principal.id } } });
      if (!current) throw new JobApplicationError("JOB_NOT_FOUND", "Job not found.");
      if (current.status === "CANCELLED") return publicJob(current);
      const immediate = current.status === "QUEUED" || current.status === "RETRY_SCHEDULED";
      const allowed = immediate || ["CLAIMED", "PROVISIONING", "RUNNING"].includes(current.status);
      if (!allowed) throw new JobApplicationError("JOB_INVALID_STATE", "Job cannot be canceled.");
      const next = immediate ? "CANCELLED" : "CANCEL_REQUESTED";
      const updated = await transaction.renderJob.updateMany({
        where: { id, ownerId: principal.id, status: current.status },
        data: {
          status: next,
          cancelRequestedAt: new Date(),
          ...(immediate ? { cancelledAt: new Date() } : {}),
        },
      });
      if (updated.count !== 1) throw new JobApplicationError("JOB_INVALID_STATE", "Job state changed concurrently.", true);
      await this.appendEvent(transaction, principal.id, id, current.status, next, "Cancellation requested.");
      return publicJob(await transaction.renderJob.findUniqueOrThrow({ where: { id_ownerId: { id, ownerId: principal.id } } }));
    });
  }

  async retry(principal: AuthenticatedPrincipal, jobId: string) {
    requireRole(principal, ["OWNER"]);
    const id = idSchema.parse(jobId);
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.renderJob.findUnique({ where: { id_ownerId: { id, ownerId: principal.id } } });
      if (!current) throw new JobApplicationError("JOB_NOT_FOUND", "Job not found.");
      if (current.status !== "FAILED") throw new JobApplicationError("JOB_INVALID_STATE", "Only failed jobs can retry.");
      if (current.retryCount >= current.maxRetries) throw new JobApplicationError("JOB_RETRY_EXHAUSTED", "Retry limit reached.");
      const updated = await transaction.renderJob.updateMany({
        where: { id, ownerId: principal.id, status: "FAILED", retryCount: current.retryCount },
        data: {
          status: "RETRY_SCHEDULED", retryCount: { increment: 1 }, nextAttemptAt: new Date(),
          errorCode: null, errorMessage: null, errorDetails: Prisma.DbNull, failedAt: null, progress: 0,
        },
      });
      if (updated.count !== 1) throw new JobApplicationError("JOB_INVALID_STATE", "Job state changed concurrently.", true);
      await this.appendEvent(transaction, principal.id, id, "FAILED", "RETRY_SCHEDULED", "Retry scheduled.");
      return publicJob(await transaction.renderJob.findUniqueOrThrow({ where: { id_ownerId: { id, ownerId: principal.id } } }));
    });
  }

  private async appendEvent(
    transaction: Prisma.TransactionClient,
    ownerId: string,
    jobId: string,
    fromStatus: RenderJobStatus,
    toStatus: RenderJobStatus,
    message: string,
  ) {
    const aggregate = await transaction.renderJobEvent.aggregate({ where: { jobId }, _max: { sequence: true } });
    await transaction.renderJobEvent.create({
      data: {
        jobId, ownerId, sequence: (aggregate._max.sequence ?? 0) + 1,
        type: "STATUS_CHANGED", fromStatus, toStatus, message,
      },
    });
  }
}
