import { randomUUID } from "node:crypto";

import { AiEngineError, safeEngineError } from "./errors";
import type { AiEngineAdapter } from "./engine-adapter";
import type { ModelManifest } from "./model-manifest";
import { resolveReadyModel } from "./model-manifest";
import { normalizeExecutionParameters } from "./parameter-normalizer";
import type { ResourceBudget } from "./schemas";
import { resourceBudgetSchema } from "./schemas";
import { compileWorkflow } from "./workflow-compiler";

export interface RuntimeClaim {
  jobId: string;
  ownerId: string;
  projectId?: string;
  generation: number;
  leaseToken: string;
  type: "IMAGE_RENDER" | "IMAGE_UPSCALE" | "IMAGE_TO_VIDEO";
  parameters: unknown;
  inputSnapshot: unknown;
  workflow: { modelId: string };
}

export interface QueuePort {
  claim(workerId: string): Promise<RuntimeClaim | null>;
  start(claim: RuntimeClaim): Promise<void>;
  heartbeat(claim: RuntimeClaim, progress: number): Promise<void>;
  succeed(claim: RuntimeClaim): Promise<void>;
  fail(claim: RuntimeClaim, code: string, retryable: boolean): Promise<void>;
  acknowledgeCancel(claim: RuntimeClaim): Promise<void>;
  isCancelRequested(claim: RuntimeClaim): Promise<boolean>;
}

export interface InputMaterializer {
  materialize(claim: RuntimeClaim): Promise<Readonly<Record<string, string>>>;
  cleanup(claim: RuntimeClaim): Promise<void>;
}

export interface OutputCommitter {
  commit(input: {
    claim: RuntimeClaim;
    executionId: string;
    filename: string;
    position: number;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void>;
}

export interface WorkerRuntimeOptions {
  workerId: string;
  budget: ResourceBudget;
  availableNodeClasses: ReadonlySet<string>;
  manifest: ModelManifest;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export class AiWorkerRuntime {
  private readonly budget: ResourceBudget;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly queue: QueuePort,
    private readonly engine: AiEngineAdapter,
    private readonly inputs: InputMaterializer,
    private readonly outputs: OutputCommitter,
    private readonly options: WorkerRuntimeOptions,
  ) {
    if (!/^[A-Za-z0-9_-]{3,160}$/.test(options.workerId)) throw new TypeError("Invalid worker ID.");
    this.budget = resourceBudgetSchema.parse(options.budget);
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async runOnce(): Promise<"IDLE" | "SUCCEEDED" | "FAILED" | "CANCELLED"> {
    const claim = await this.queue.claim(this.options.workerId);
    if (!claim) return "IDLE";
    const startedAt = this.now();
    let executionId: string | null = null;
    let inputsCleaned = false;
    try {
      await this.queue.start(claim);
      if (await this.engine.health() !== "READY") throw new AiEngineError("AI_ENGINE_DISCONNECTED", "Engine is not ready.", true);
      const model = resolveReadyModel(this.options.manifest, claim.workflow.modelId, claim.type, this.options.availableNodeClasses);
      if (model.estimatedVramMb > this.budget.maxEstimatedVramMb) throw new AiEngineError("AI_ENGINE_CAPABILITY_MISSING", "Model exceeds worker VRAM budget.");
      const files = await this.inputs.materialize(claim);
      const parameters = normalizeExecutionParameters({ jobId: claim.jobId, type: claim.type, parameters: claim.parameters, inputSnapshot: claim.inputSnapshot });
      const workflow = compileWorkflow({ parameters, model, inputFiles: files, outputPrefix: `job_${claim.jobId.replaceAll("-", "")}` });
      executionId = await this.engine.submit({ requestId: randomUUID(), jobId: claim.jobId, generation: claim.generation, workflow });
      while (this.now() - startedAt < this.budget.timeoutMs) {
        if (await this.queue.isCancelRequested(claim)) {
          await this.engine.cancel(executionId);
          await this.inputs.cleanup(claim);
          inputsCleaned = true;
          await this.queue.acknowledgeCancel(claim);
          return "CANCELLED";
        }
        const status = await this.engine.status(executionId);
        await this.queue.heartbeat(claim, status.progress);
        if (status.state === "FAILED") throw new AiEngineError("AI_ENGINE_PROVIDER_REJECTED", "Engine execution failed.", false);
        if (status.state === "CANCELLED") {
          await this.queue.acknowledgeCancel(claim);
          return "CANCELLED";
        }
        if (status.state === "SUCCEEDED") {
          if (status.outputs.length < 1 || status.outputs.length > 8) throw new AiEngineError("AI_ENGINE_OUTPUT_INVALID", "Engine output count is invalid.");
          for (const [position, output] of status.outputs.entries()) {
            if (output.byteSize > this.budget.maxOutputBytes) throw new AiEngineError("AI_ENGINE_OUTPUT_INVALID", "Engine output is oversized.");
            const bytes = await this.engine.readOutput(executionId, output.filename, this.budget.maxOutputBytes);
            await this.outputs.commit({ claim, executionId, filename: output.filename, position, bytes, contentType: output.contentType });
          }
          await this.inputs.cleanup(claim);
          inputsCleaned = true;
          await this.queue.succeed(claim);
          return "SUCCEEDED";
        }
        await this.wait(this.budget.pollIntervalMs);
      }
      if (executionId) await this.engine.cancel(executionId).catch(() => undefined);
      throw new AiEngineError("AI_ENGINE_TIMEOUT", "Execution exceeded its time budget.", true);
    } catch (error) {
      const safe = safeEngineError(error);
      try {
        await this.queue.fail(claim, safe.code, safe.retryable);
      } catch (queueError) {
        const code = queueError && typeof queueError === "object" && "code" in queueError
          ? (queueError as { code?: unknown }).code
          : undefined;
        // Lease recovery may have reassigned the job while the engine call was in flight.
        // The old worker is already fenced, so it must stop quietly instead of terminating
        // the whole polling process. Transport/database errors still escape and fail closed.
        if (code !== "JOB_STALE_WORKER") throw queueError;
      }
      return "FAILED";
    } finally {
      if (!inputsCleaned) await this.inputs.cleanup(claim).catch(() => undefined);
    }
  }
}
