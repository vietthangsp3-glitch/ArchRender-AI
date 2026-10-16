import { createHash } from "node:crypto";

import { AiWorkerRuntime, type AiEngineAdapter, type ModelManifest, type QueuePort, type RuntimeClaim } from "@archrender/ai-engine";
import { describe, expect, it, vi } from "vitest";

import { VerifiedInputMaterializer } from "../src/input-materializer";
import { ImmutableOutputCommitter } from "../src/output-committer";

const bytes = Uint8Array.from([137, 80, 78, 71]);
const checksum = createHash("sha256").update(bytes).digest("hex");
const snapshot = {
  assetId: "83f31e87-18d4-4ac1-980e-8cb4416a2d30",
  role: "SOURCE_IMAGE" as const,
  position: 0,
  storageObjectId: "e1cdf8dd-9f8f-4f62-9ed4-55757e83980d",
  checksumSha256: checksum,
  storageEtag: "synthetic-etag",
  contentType: "image/png" as const,
};
const claim: RuntimeClaim = {
  jobId: "5d93ec65-2de8-451c-bbf8-b37854af763c",
  ownerId: "9e24af5b-8f6e-4a1e-b4e9-852692e825d6",
  projectId: "af248ce0-19be-4ec5-9a14-87c72527e607",
  generation: 1,
  leaseToken: "test-lease-token-with-at-least-32-characters",
  type: "IMAGE_RENDER",
  workflow: { modelId: "test_model" },
  parameters: { prompt: "architectural courtyard", width: 512, height: 512, steps: 10, guidance: 5, strength: 0.5, seed: 1 },
  inputSnapshot: [snapshot],
};
const manifest: ModelManifest = {
  schemaVersion: 2,
  generatedAt: "2026-10-16T00:00:00.000Z",
  models: [{
    id: "test_model", revision: "1", status: "READY", jobTypes: ["IMAGE_RENDER"], estimatedVramMb: 1024,
    requiredNodeClasses: ["LoadImage", "CheckpointLoaderSimple", "CLIPTextEncode", "VAEEncode", "KSampler", "VAEDecode", "SaveImage"],
    artifacts: [{
      name: "model.safetensors", relativePath: "checkpoints/model.safetensors", sha256: "a".repeat(64),
      sourceUrl: "https://example.invalid/model", sourceRevision: "b".repeat(40), sizeBytes: 1024,
      license: "TEST", licenseUrl: "https://example.invalid/license", commercialUse: "PERMITTED", status: "VERIFIED",
    }],
  }],
};

describe("GPU worker orchestration with fake private services", () => {
  it("materializes an immutable R2 input, executes, commits output, and cleans the exact gateway file", async () => {
    const queue = {
      claim: vi.fn(async () => claim), start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined),
      succeed: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), acknowledgeCancel: vi.fn(async () => undefined),
      isCancelRequested: vi.fn(async () => false),
    } satisfies QueuePort;
    const database = { assetStorageObject: { findUnique: vi.fn(async () => ({
      id: snapshot.storageObjectId,
      assetId: snapshot.assetId,
      ownerId: claim.ownerId,
      role: "ORIGINAL",
      state: "VERIFIED",
      checksumSha256: checksum,
      storageEtag: "synthetic-etag",
      contentType: "image/png",
      deletedAt: null,
      byteSize: BigInt(bytes.byteLength),
      objectKey: "synthetic/exact/input.png",
    })) } };
    const storage = { readObject: vi.fn(async () => ({ bytes, contentLength: bytes.byteLength, contentType: "image/png", etag: "synthetic-etag", metadata: {} })) };
    const gateway = {
      stageInput: vi.fn(async (_workspace: string, filename: string) => `staged_${filename}`),
      deleteInput: vi.fn(async () => undefined),
    };
    const engine = {
      providerId: "fake-comfyui",
      health: vi.fn(async () => "READY" as const),
      submit: vi.fn(async () => "execution-id"),
      status: vi.fn(async () => ({ executionId: "execution-id", state: "SUCCEEDED" as const, progress: 100, outputs: [{ filename: "result.png", contentType: "image/png", byteSize: bytes.byteLength }], errorCode: null })),
      readOutput: vi.fn(async () => bytes),
      cancel: vi.fn(async () => undefined),
    } satisfies AiEngineAdapter;
    const generatedCommit = vi.fn(async () => undefined);
    const runtime = new AiWorkerRuntime(
      queue,
      engine,
      new VerifiedInputMaterializer(database as never, storage as never, gateway as never, 1024),
      new ImmutableOutputCommitter({ commit: generatedCommit } as never),
      {
        workerId: "worker_orchestration_test",
        manifest,
        availableNodeClasses: new Set(manifest.models[0]!.requiredNodeClasses),
        budget: { timeoutMs: 5_000, pollIntervalMs: 250, maxOutputBytes: 1024, maxEstimatedVramMb: 2048, maxAttempts: 1 },
      },
    );

    await expect(runtime.runOnce()).resolves.toBe("SUCCEEDED");
    expect(storage.readObject).toHaveBeenCalledWith("synthetic/exact/input.png", 1024, { ifMatch: "synthetic-etag" });
    expect(gateway.stageInput).toHaveBeenCalledOnce();
    expect(generatedCommit).toHaveBeenCalledWith(expect.objectContaining({ jobId: claim.jobId, ownerId: claim.ownerId, generation: 1 }));
    expect(gateway.deleteInput).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), "source.png", checksum);
    expect(queue.succeed).toHaveBeenCalledWith(claim);
  });
});
