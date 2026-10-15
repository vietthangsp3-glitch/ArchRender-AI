import { describe, expect, it } from "vitest";

import { AiEngineError, modelManifestSchema, resolveReadyModel } from "../src";

const artifact = {
  name: "model.safetensors",
  relativePath: "checkpoints/model.safetensors",
  sha256: "a".repeat(64),
  sourceUrl: "https://example.invalid/model.safetensors",
  sourceRevision: "b".repeat(40),
  sizeBytes: 1024,
  license: "TEST-ONLY",
  licenseUrl: "https://example.invalid/license",
  commercialUse: "PERMITTED" as const,
  status: "VERIFIED" as const,
};

describe("model manifests", () => {
  it("fails closed when an artifact is not verified", () => {
    const manifest = modelManifestSchema.parse({
      schemaVersion: 2,
      generatedAt: "2026-10-15T00:00:00.000Z",
      models: [{
        id: "test_model", revision: "test", status: "PENDING_VERIFICATION",
        jobTypes: ["IMAGE_RENDER"], requiredNodeClasses: ["LoadImage"], estimatedVramMb: 1024,
        artifacts: [{ ...artifact, sha256: null, sourceUrl: null, sourceRevision: null, sizeBytes: null,
          license: null, licenseUrl: null, commercialUse: "UNKNOWN", status: "PENDING_VERIFICATION" }],
      }],
    });
    expect(() => resolveReadyModel(manifest, "test_model", "IMAGE_RENDER", new Set(["LoadImage"])))
      .toThrowError(AiEngineError);
  });

  it("requires all declared node capabilities", () => {
    const manifest = modelManifestSchema.parse({
      schemaVersion: 2,
      generatedAt: "2026-10-15T00:00:00.000Z",
      models: [{
        id: "test_model", revision: "test", status: "READY", jobTypes: ["IMAGE_RENDER"],
        requiredNodeClasses: ["LoadImage", "KSampler"], estimatedVramMb: 1024, artifacts: [artifact],
      }],
    });
    expect(() => resolveReadyModel(manifest, "test_model", "IMAGE_RENDER", new Set(["LoadImage"])))
      .toThrow(/capability/i);
  });

  it("does not accept a locally verified artifact without registry and license evidence", () => {
    expect(() => modelManifestSchema.parse({
      schemaVersion: 2,
      generatedAt: "2026-10-16T00:00:00.000Z",
      models: [{
        id: "test_model", revision: "test", status: "READY", jobTypes: ["IMAGE_RENDER"],
        requiredNodeClasses: ["LoadImage"], estimatedVramMb: 1024,
        artifacts: [{ ...artifact, sizeBytes: null }],
      }],
    })).toThrow(/pinned source/i);
  });
});
