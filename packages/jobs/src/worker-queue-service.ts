import { createHash, randomBytes } from "node:crypto";

import { Prisma, type PrismaClient, type RenderJobStatus } from "@archrender/database";

import { JobApplicationError } from "./errors";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface WorkerClaim {
  jobId: string;
  ownerId: string;
  projectId: string;
  generation: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  type: "IMAGE_RENDER" | "IMAGE_UPSCALE" | "IMAGE_TO_VIDEO";
  parameters: unknown;
  inputSnapshot: unknown;
  workflowVersionId: string;
  workflow: { modelId: string };
}

export interface WorkerClaimScope {
  jobId: string;
}

interface ClaimedRow {
  id: string;
  ownerId: string;
  projectId: string;
  type: WorkerClaim["type"];
  parameters: unknown;
  inputSnapshot: unknown;
  workflowVersionId: string;
  executionGeneration: number;
  leaseExpiresAt: Date;
  previousStatus: RenderJobStatus;
}

export class WorkerQueueService {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(workerId: string, leaseSeconds = 60, scope?: WorkerClaimScope): Promise<WorkerClaim | null> {
    if (!/^[A-Za-z0-9_-]{3,160}$/.test(workerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 600) {
      throw new JobApplicationError("JOB_INVALID_INPUT", "Invalid worker claim policy.");
    }
    if (scope && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope.jobId)) {
      throw new JobApplicationError("JOB_INVALID_INPUT", "Invalid worker claim scope.");
    }
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseTokenHash = hashToken(leaseToken);
    const leaseExpiresAt = new Date(this.now().getTime() + leaseSeconds * 1_000);
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id", "status" AS "previousStatus"
          FROM "RenderJob"
          WHERE "status" IN ('QUEUED'::"RenderJobStatus", 'RETRY_SCHEDULED'::"RenderJobStatus")
            ${scope ? Prisma.sql`AND "id" = ${scope.jobId}::uuid` : Prisma.empty}
            AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${this.now()})
            AND "workflowVersionId" IS NOT NULL
            AND jsonb_typeof("inputSnapshot") = 'array'
            AND jsonb_array_length("inputSnapshot") > 0
          ORDER BY "priority" DESC, "createdAt" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "RenderJob" AS job
        SET "status" = 'CLAIMED'::"RenderJobStatus",
            "leaseOwner" = ${workerId},
            "leaseTokenHash" = ${leaseTokenHash},
            "leaseExpiresAt" = ${leaseExpiresAt},
            "executionGeneration" = "executionGeneration" + 1,
            "nextAttemptAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job."id", job."ownerId", job."projectId", job."type", job."parameters",
                  job."inputSnapshot", job."workflowVersionId",
                  job."executionGeneration", job."leaseExpiresAt", candidate."previousStatus"
      `);
      const job = rows[0];
      if (!job || !job.workflowVersionId) return null;
      const workflowVersion = await transaction.workflowVersion.findUnique({
        where: { id_ownerId: { id: job.workflowVersionId, ownerId: job.ownerId } },
        select: { parameters: true },
      });
      const workflowParameters = workflowVersion?.parameters;
      const modelId = workflowParameters && typeof workflowParameters === "object" && !Array.isArray(workflowParameters)
        ? (workflowParameters as Record<string, unknown>)["modelFamily"]
        : null;
      if (typeof modelId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,80}$/.test(modelId)) {
        throw new JobApplicationError("JOB_WORKFLOW_INVALID", "Claimed job workflow model is invalid.");
      }
      const previousAttempts = await transaction.renderJobAttempt.count({ where: { jobId: job.id } });
      await transaction.renderJobAttempt.create({
        data: {
          jobId: job.id, ownerId: job.ownerId, attemptNumber: previousAttempts + 1,
          generation: job.executionGeneration, workerId, leaseTokenHash,
          status: "CLAIMED", leaseExpiresAt,
        },
      });
      await this.appendEvent(transaction, job.ownerId, job.id, job.previousStatus, "CLAIMED", "Worker claimed job.");
      return {
        jobId: job.id,
        ownerId: job.ownerId,
        projectId: job.projectId,
        generation: job.executionGeneration,
        leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        type: job.type,
        parameters: job.parameters,
        inputSnapshot: job.inputSnapshot,
        workflowVersionId: job.workflowVersionId,
        workflow: { modelId },
      };
    });
  }

  async start(claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">) {
    const tokenHash = hashToken(claim.leaseToken);
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.renderJob.updateMany({
        where: {
          id: claim.jobId, executionGeneration: claim.generation, leaseTokenHash: tokenHash,
          status: "CLAIMED", leaseExpiresAt: { gt: this.now() },
        },
        data: { status: "RUNNING", startedAt: this.now(), progress: 0 },
      });
      if (changed.count !== 1) throw new JobApplicationError("JOB_STALE_WORKER", "Worker claim is stale.");
      const job = await transaction.renderJob.findUniqueOrThrow({ where: { id: claim.jobId } });
      await transaction.renderJobAttempt.updateMany({
        where: { jobId: claim.jobId, generation: claim.generation, leaseTokenHash: tokenHash, status: "CLAIMED" },
        data: { status: "RUNNING", startedAt: this.now(), lastHeartbeatAt: this.now() },
      });
      await this.appendEvent(transaction, job.ownerId, job.id, "CLAIMED", "RUNNING", "Worker started job.");
    });
  }

  async heartbeat(
    claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">,
    progress: number,
    leaseSeconds = 60,
  ) {
    if (!Number.isFinite(progress) || progress < 0 || progress > 100 || !Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 600) {
      throw new JobApplicationError("JOB_INVALID_INPUT", "Invalid heartbeat.");
    }
    const tokenHash = hashToken(claim.leaseToken);
    const leaseExpiresAt = new Date(this.now().getTime() + leaseSeconds * 1_000);
    const changed = await this.database.renderJob.updateMany({
      where: {
        id: claim.jobId, executionGeneration: claim.generation, leaseTokenHash: tokenHash,
        status: { in: ["RUNNING", "CANCEL_REQUESTED"] }, leaseExpiresAt: { gt: this.now() },
      },
      data: { progress, leaseExpiresAt },
    });
    if (changed.count !== 1) throw new JobApplicationError("JOB_STALE_WORKER", "Worker heartbeat rejected.");
    await this.database.renderJobAttempt.updateMany({
      where: { jobId: claim.jobId, generation: claim.generation, leaseTokenHash: tokenHash },
      data: { lastHeartbeatAt: this.now(), leaseExpiresAt },
    });
  }

  async isCancelRequested(claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">) {
    const current = await this.database.renderJob.findUnique({
      where: { id: claim.jobId },
      select: { status: true, executionGeneration: true, leaseTokenHash: true, leaseExpiresAt: true },
    });
    if (!current || current.executionGeneration !== claim.generation || current.leaseTokenHash !== hashToken(claim.leaseToken) ||
        !current.leaseExpiresAt || current.leaseExpiresAt <= this.now()) {
      throw new JobApplicationError("JOB_STALE_WORKER", "Worker claim is stale.");
    }
    return current.status === "CANCEL_REQUESTED";
  }

  async succeed(claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">) {
    return this.finish(claim, "SUCCEEDED");
  }

  async fail(
    claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">,
    errorCode: string,
    retryable: boolean,
  ) {
    if (!/^[A-Z0-9_]{1,128}$/.test(errorCode)) {
      throw new JobApplicationError("JOB_INVALID_INPUT", "Unsafe worker error code.");
    }
    return this.finish(claim, "FAILED", errorCode, retryable);
  }

  async acknowledgeCancel(claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">) {
    return this.finish(claim, "CANCELLED");
  }

  async recoverExpired(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JobApplicationError("JOB_INVALID_INPUT", "Invalid recovery batch.");
    return this.database.$transaction(async (transaction) => {
      const expired = await transaction.$queryRaw<Array<{
        id: string; ownerId: string; status: RenderJobStatus; executionGeneration: number;
        retryCount: number; maxRetries: number;
      }>>(Prisma.sql`
        SELECT "id", "ownerId", "status", "executionGeneration", "retryCount", "maxRetries"
        FROM "RenderJob"
        WHERE "status" IN ('CLAIMED'::"RenderJobStatus", 'RUNNING'::"RenderJobStatus", 'CANCEL_REQUESTED'::"RenderJobStatus")
          AND "leaseExpiresAt" <= ${this.now()}
        ORDER BY "leaseExpiresAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      let recovered = 0;
      for (const job of expired) {
        const cancel = job.status === "CANCEL_REQUESTED";
        const exhausted = job.retryCount >= job.maxRetries;
        const next: RenderJobStatus = cancel ? "CANCELLED" : exhausted ? "FAILED" : "RETRY_SCHEDULED";
        const changed = await transaction.renderJob.updateMany({
          where: { id: job.id, status: job.status, executionGeneration: job.executionGeneration },
          data: {
            status: next,
            leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null,
            ...(next === "RETRY_SCHEDULED"
              ? { retryCount: { increment: 1 }, nextAttemptAt: new Date(this.now().getTime() + 5_000) }
              : next === "FAILED"
                ? { failedAt: this.now(), errorCode: "WORKER_LEASE_EXPIRED" }
                : { cancelledAt: this.now() }),
          },
        });
        if (changed.count !== 1) continue;
        await transaction.renderJobAttempt.updateMany({
          where: { jobId: job.id, generation: job.executionGeneration },
          data: { status: "LEASE_EXPIRED", finishedAt: this.now(), errorCode: "WORKER_LEASE_EXPIRED" },
        });
        await this.appendEvent(transaction, job.ownerId, job.id, job.status, next, "Expired worker lease recovered.");
        recovered += 1;
      }
      return recovered;
    });
  }

  private async finish(
    claim: Pick<WorkerClaim, "jobId" | "generation" | "leaseToken">,
    requested: "SUCCEEDED" | "FAILED" | "CANCELLED",
    errorCode?: string,
    retryable = false,
  ) {
    const tokenHash = hashToken(claim.leaseToken);
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.renderJob.findUnique({ where: { id: claim.jobId } });
      if (
        !current || current.executionGeneration !== claim.generation || current.leaseTokenHash !== tokenHash ||
        !current.leaseExpiresAt || current.leaseExpiresAt <= this.now() ||
        !["RUNNING", "CANCEL_REQUESTED"].includes(current.status)
      ) {
        throw new JobApplicationError("JOB_STALE_WORKER", "Stale worker completion rejected.");
      }
      const canceled = current.status === "CANCEL_REQUESTED";
      const retryScheduled = requested === "FAILED" && retryable && current.retryCount < current.maxRetries;
      const next: RenderJobStatus = canceled ? "CANCELLED" : retryScheduled ? "RETRY_SCHEDULED" : requested;
      const changed = await transaction.renderJob.updateMany({
        where: {
          id: claim.jobId, status: current.status, executionGeneration: claim.generation,
          leaseTokenHash: tokenHash,
        },
        data: {
          status: next,
          leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null,
          ...(next === "SUCCEEDED" ? { progress: 100, completedAt: this.now() } : {}),
          ...(next === "CANCELLED" ? { cancelledAt: this.now() } : {}),
          ...(next === "FAILED" ? { failedAt: this.now(), ...(errorCode ? { errorCode } : {}) } : {}),
          ...(next === "RETRY_SCHEDULED" ? {
            retryCount: { increment: 1 },
            nextAttemptAt: new Date(this.now().getTime() + 5_000),
            ...(errorCode ? { errorCode } : {}),
          } : {}),
        },
      });
      if (changed.count !== 1) throw new JobApplicationError("JOB_STALE_WORKER", "Concurrent completion rejected.");
      await transaction.renderJobAttempt.updateMany({
        where: { jobId: claim.jobId, generation: claim.generation, leaseTokenHash: tokenHash },
        data: {
          status: next === "RETRY_SCHEDULED" ? "FAILED" : next,
          finishedAt: this.now(), ...(errorCode ? { errorCode } : {}),
        },
      });
      await this.appendEvent(transaction, current.ownerId, current.id, current.status, next, `Worker finished with ${next}.`);
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
