import { describe, expect, it } from "vitest";

import {
  canTransition,
  createWorkflowSchema,
  imageParametersSchema,
  isTerminal,
  submitJobSchema,
  validateJobParameters,
  videoParametersSchema,
  workflowConfigurationSchema,
} from "../src/index.js";

describe("render job domain contracts", () => {
  it("permits only monotonic lifecycle transitions", () => {
    expect(canTransition("QUEUED", "CLAIMED")).toBe(true);
    expect(canTransition("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canTransition("SUCCEEDED", "CANCELLED")).toBe(false);
    expect(canTransition("CANCELLED", "RUNNING")).toBe(false);
    expect(isTerminal("FAILED")).toBe(true);
  });

  it("validates bounded image parameters and rejects unknown fields", () => {
    expect(imageParametersSchema.parse({ prompt: "house", width: 1024, height: 768 })).toMatchObject({ steps: 30 });
    expect(() => imageParametersSchema.parse({ prompt: "house", width: 1025, height: 768 })).toThrow();
    expect(() => imageParametersSchema.parse({ prompt: "house", width: 1024, height: 768, shell: "rm" })).toThrow();
  });

  it("validates bounded video parameters", () => {
    expect(videoParametersSchema.parse({
      prompt: "camera move", durationSeconds: 5, fps: 24, motion: "DOLLY_IN", quality: "STANDARD",
    })).toMatchObject({ fps: 24 });
    expect(() => validateJobParameters("IMAGE_TO_VIDEO", {
      prompt: "camera move", durationSeconds: 120, fps: 60, motion: "DOLLY_IN", quality: "HIGH",
    })).toThrow();
  });

  it("treats workflow JSON as strict data rather than executable configuration", () => {
    expect(workflowConfigurationSchema.parse({
      backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1",
      modelFamily: "sdxl", conditioning: ["IMAGE", "DEPTH"],
    })).toMatchObject({ modelFamily: "sdxl" });
    expect(() => workflowConfigurationSchema.parse({
      backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1",
      modelFamily: "sdxl", conditioning: [], command: "powershell.exe",
    })).toThrow();
  });

  it("requires bounded immutable submission inputs", () => {
    const base = {
      idempotencyKey: "request_0000000000001",
      projectId: "00000000-0000-4000-8000-000000000001",
      workflowVersionId: "00000000-0000-4000-8000-000000000002",
      type: "IMAGE_RENDER",
      inputs: [{ assetId: "00000000-0000-4000-8000-000000000003", role: "SOURCE_IMAGE", position: 0 }],
      parameters: { prompt: "house", width: 1024, height: 768 },
    };
    expect(submitJobSchema.parse(base).inputs).toHaveLength(1);
    expect(() => submitJobSchema.parse({ ...base, priority: 99 })).toThrow();
    expect(() => submitJobSchema.parse({ ...base, type: "IMAGE_TO_VIDEO" })).toThrow();
    expect(submitJobSchema.parse({ ...base, type: "IMAGE_TO_VIDEO", inputs: [{ ...base.inputs[0], role: "START_FRAME" }] }).type).toBe("IMAGE_TO_VIDEO");
  });

  it("requires workflow kind and configuration kind to be explicit", () => {
    expect(createWorkflowSchema.parse({
      name: "Arch image", kind: "IMAGE_RENDER",
      configuration: {
        backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1",
        modelFamily: "sdxl", conditioning: ["IMAGE"],
      },
    }).parameterSchemaVersion).toBe("1");
  });
});
