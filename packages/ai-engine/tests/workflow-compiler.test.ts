import { describe, expect, it } from "vitest";

import { compileWorkflow, validateCompiledPrompt, type ModelDefinition } from "../src";

const model: ModelDefinition = {
  id: "test_model", revision: "1", status: "READY", jobTypes: ["IMAGE_RENDER"], estimatedVramMb: 1024,
  requiredNodeClasses: ["LoadImage", "CheckpointLoaderSimple", "KSampler", "SaveImage"],
  artifacts: [{ name: "model.safetensors", relativePath: "checkpoints/model.safetensors", sha256: "a".repeat(64),
    sourceUrl: "https://example.invalid/model", sourceRevision: "b".repeat(40), sizeBytes: 1024,
    license: "TEST", licenseUrl: "https://example.invalid/license", commercialUse: "PERMITTED", status: "VERIFIED" }],
};

const parameters = {
  kind: "IMAGE_RENDER", prompt: "architectural exterior", negativePrompt: "", width: 1024, height: 1024,
  steps: 30, guidance: 7, strength: 0.7, seed: 42, sampler: "dpmpp_2m", scheduler: "karras",
  controls: [], outputFormat: "png",
};

describe("workflow compiler", () => {
  it("is deterministic and contains only allowlisted nodes", () => {
    const one = compileWorkflow({ parameters, model, inputFiles: { source: "input.png" }, outputPrefix: "job_12345678" });
    const two = compileWorkflow({ parameters, model, inputFiles: { source: "input.png" }, outputPrefix: "job_12345678" });
    expect(one.promptHash).toBe(two.promptHash);
    expect(() => validateCompiledPrompt(one.prompt)).not.toThrow();
  });

  it("rejects URLs, traversal and arbitrary nodes", () => {
    expect(() => compileWorkflow({ parameters, model, inputFiles: { source: "https://attacker/input.png" }, outputPrefix: "job_12345678" })).toThrow();
    expect(() => validateCompiledPrompt({ "1": { class_type: "ExecuteShell", inputs: {}, _meta: { title: "bad" } } })).toThrow(/forbidden/i);
  });
});
