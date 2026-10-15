import { describe, expect, it } from "vitest";
import { projectNameSchema, renderSettingsSchema } from "@archrender/schemas";

describe("render settings schema", () => {
  it("accepts a production-shaped payload", () => {
    const result = renderSettingsSchema.safeParse({ prompt: "Modern villa at dusk", negativePrompt: "distorted", seed: 42, steps: 30, cfg: 5.5, denoise: 0.26 });
    expect(result.success).toBe(true);
  });

  it("rejects unsafe render ranges", () => {
    const result = renderSettingsSchema.safeParse({ prompt: "too short", negativePrompt: "", seed: 42, steps: 500, cfg: 5.5, denoise: 2 });
    expect(result.success).toBe(false);
  });
});

describe("project name schema", () => {
  it("trims and validates project names", () => {
    expect(projectNameSchema.parse("  Villa Riverside  ")).toBe("Villa Riverside");
  });
});
