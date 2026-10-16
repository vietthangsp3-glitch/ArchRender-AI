import { describe, expect, it, vi } from "vitest";

import { AiWorkerRuntime, type AiEngineAdapter, type ModelManifest, type QueuePort, type RuntimeClaim } from "../src";

const claim: RuntimeClaim = {
  jobId: "5d93ec65-2de8-451c-bbf8-b37854af763c", ownerId: "9e24af5b-8f6e-4a1e-b4e9-852692e825d6",
  generation: 1, leaseToken: "secret-lease-token", type: "IMAGE_RENDER", workflow: { modelId: "test_model" },
  inputSnapshot: [], parameters: { prompt: "render", negativePrompt: "", width: 512, height: 512, steps: 10, guidance: 5, strength: 0.5, seed: 1 },
};
const manifest: ModelManifest = { schemaVersion: 2, generatedAt: "2026-10-15T00:00:00.000Z", models: [{
  id: "test_model", revision: "1", status: "READY", jobTypes: ["IMAGE_RENDER"], estimatedVramMb: 1024,
  requiredNodeClasses: ["LoadImage", "CheckpointLoaderSimple", "KSampler", "SaveImage"],
  artifacts: [{ name: "model.safetensors", relativePath: "checkpoints/model.safetensors", sha256: "a".repeat(64),
    sourceUrl: "https://example.invalid/model", sourceRevision: "b".repeat(40), sizeBytes: 1024,
    license: "TEST", licenseUrl: "https://example.invalid/license", commercialUse: "PERMITTED", status: "VERIFIED" }],
}] };

describe("AI worker runtime", () => {
  it("claims, executes, commits output, then fences success through the queue", async () => {
    const queue = {
      claim: vi.fn(async () => claim), start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined),
      succeed: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), acknowledgeCancel: vi.fn(async () => undefined),
      isCancelRequested: vi.fn(async () => false),
    } satisfies QueuePort;
    const engine = {
      providerId: "fake", health: vi.fn(async () => "READY" as const), submit: vi.fn(async () => "execution"),
      status: vi.fn(async () => ({ executionId: "5d93ec65-2de8-451c-bbf8-b37854af763c", state: "SUCCEEDED" as const, progress: 100, outputs: [{ filename: "output.png", contentType: "image/png", byteSize: 12 }], errorCode: null })),
      cancel: vi.fn(async () => undefined), readOutput: vi.fn(async () => new Uint8Array(12)),
    } satisfies AiEngineAdapter;
    const commit = vi.fn(async () => undefined);
    const runtime = new AiWorkerRuntime(queue, engine, { materialize: async () => ({ source: "input.png" }), cleanup: async () => undefined }, { commit }, {
      workerId: "worker_test", manifest, availableNodeClasses: new Set(["LoadImage", "CheckpointLoaderSimple", "KSampler", "SaveImage"]),
      budget: { timeoutMs: 5000, pollIntervalMs: 250, maxOutputBytes: 1024, maxEstimatedVramMb: 2048, maxAttempts: 1 },
    });
    await expect(runtime.runOnce()).resolves.toBe("SUCCEEDED");
    expect(commit).toHaveBeenCalledOnce();
    expect(queue.succeed).toHaveBeenCalledWith(claim);
  });

  it("fails retryably without submitting when the provider is disconnected", async () => {
    const queue = {
      claim: vi.fn(async () => claim), start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined),
      succeed: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), acknowledgeCancel: vi.fn(async () => undefined),
      isCancelRequested: vi.fn(async () => false),
    } satisfies QueuePort;
    const engine = {
      providerId: "fake", health: vi.fn(async () => "DISCONNECTED" as const), submit: vi.fn(), status: vi.fn(),
      cancel: vi.fn(async () => undefined), readOutput: vi.fn(),
    } as unknown as AiEngineAdapter;
    const runtime = new AiWorkerRuntime(queue, engine, { materialize: vi.fn(), cleanup: vi.fn(async () => undefined) }, { commit: vi.fn() }, {
      workerId: "worker_test", manifest, availableNodeClasses: new Set(),
      budget: { timeoutMs: 5000, pollIntervalMs: 250, maxOutputBytes: 1024, maxEstimatedVramMb: 2048, maxAttempts: 1 },
    });
    await expect(runtime.runOnce()).resolves.toBe("FAILED");
    expect(queue.fail).toHaveBeenCalledWith(claim, "AI_ENGINE_DISCONNECTED", true);
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it("does not terminate the polling process when lease recovery fences failure reporting", async () => {
    const queue = {
      claim: vi.fn(async () => claim), start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined),
      succeed: vi.fn(async () => undefined),
      fail: vi.fn(async () => { throw Object.assign(new Error("stale"), { code: "JOB_STALE_WORKER" }); }),
      acknowledgeCancel: vi.fn(async () => undefined), isCancelRequested: vi.fn(async () => false),
    } satisfies QueuePort;
    const engine = {
      providerId: "fake", health: vi.fn(async () => "DISCONNECTED" as const), submit: vi.fn(), status: vi.fn(),
      cancel: vi.fn(async () => undefined), readOutput: vi.fn(),
    } as unknown as AiEngineAdapter;
    const runtime = new AiWorkerRuntime(queue, engine, { materialize: vi.fn(), cleanup: vi.fn(async () => undefined) }, { commit: vi.fn() }, {
      workerId: "worker_test", manifest, availableNodeClasses: new Set(),
      budget: { timeoutMs: 5000, pollIntervalMs: 250, maxOutputBytes: 1024, maxEstimatedVramMb: 2048, maxAttempts: 1 },
    });
    await expect(runtime.runOnce()).resolves.toBe("FAILED");
    expect(queue.fail).toHaveBeenCalledWith(claim, "AI_ENGINE_DISCONNECTED", true);
  });

  it("propagates cancellation and cleans staged inputs before acknowledging", async () => {
    const queue = {
      claim: vi.fn(async () => claim), start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined),
      succeed: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), acknowledgeCancel: vi.fn(async () => undefined),
      isCancelRequested: vi.fn(async () => true),
    } satisfies QueuePort;
    const engine = {
      providerId: "fake", health: vi.fn(async () => "READY" as const), submit: vi.fn(async () => "execution"), status: vi.fn(),
      cancel: vi.fn(async () => undefined), readOutput: vi.fn(),
    } as unknown as AiEngineAdapter;
    const cleanup = vi.fn(async () => undefined);
    const runtime = new AiWorkerRuntime(queue, engine, { materialize: async () => ({ source: "input.png" }), cleanup }, { commit: vi.fn() }, {
      workerId: "worker_test", manifest, availableNodeClasses: new Set(["LoadImage", "CheckpointLoaderSimple", "KSampler", "SaveImage"]),
      budget: { timeoutMs: 5000, pollIntervalMs: 250, maxOutputBytes: 1024, maxEstimatedVramMb: 2048, maxAttempts: 1 },
    });
    await expect(runtime.runOnce()).resolves.toBe("CANCELLED");
    expect(engine.cancel).toHaveBeenCalledWith("execution");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(queue.acknowledgeCancel).toHaveBeenCalledWith(claim);
  });
});
