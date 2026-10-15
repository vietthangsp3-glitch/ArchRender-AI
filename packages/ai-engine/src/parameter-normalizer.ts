import { createHash } from "node:crypto";
import { z } from "zod";

import { AiEngineError } from "./errors";
import { executionParametersSchema, type ExecutionParameters } from "./schemas";

const legacyImage = z.object({
  prompt: z.string(), negativePrompt: z.string().optional(), strength: z.number(), steps: z.number(),
  guidance: z.number(), width: z.number(), height: z.number(), seed: z.number().optional(),
}).strict();
const legacyVideo = z.object({
  prompt: z.string(), durationSeconds: z.number(), fps: z.number(),
  motion: z.enum(["STATIC", "PAN_LEFT", "PAN_RIGHT", "DOLLY_IN", "DOLLY_OUT", "ORBIT"]),
  quality: z.enum(["DRAFT", "STANDARD", "HIGH"]), seed: z.number().optional(),
}).strict();

export function normalizeExecutionParameters(input: {
  jobId: string;
  type: "IMAGE_RENDER" | "IMAGE_UPSCALE" | "IMAGE_TO_VIDEO";
  parameters: unknown;
  inputSnapshot: unknown;
}): ExecutionParameters {
  const fallbackSeed = createHash("sha256").update(input.jobId).digest().readUInt32BE(0) & 0x7fffffff;
  if (input.type === "IMAGE_TO_VIDEO") {
    const value = legacyVideo.parse(input.parameters);
    const profiles = {
      DRAFT: { width: 768, height: 432, steps: 12, guidance: 4 },
      STANDARD: { width: 1024, height: 576, steps: 24, guidance: 5 },
      HIGH: { width: 1280, height: 720, steps: 36, guidance: 6 },
    } as const;
    const profile = profiles[value.quality];
    return executionParametersSchema.parse({
      kind: input.type, prompt: value.prompt, negativePrompt: "", ...profile,
      frames: Math.min(value.durationSeconds * value.fps, 241), fps: value.fps,
      seed: value.seed ?? fallbackSeed, startFrameInputName: "start_frame", outputFormat: "mp4",
    });
  }
  const value = legacyImage.parse(input.parameters);
  const snapshots = z.array(z.object({ role: z.string(), position: z.number().int() }).passthrough()).parse(input.inputSnapshot);
  const controls = snapshots.filter((item) => item.role === "CONTROL_IMAGE").map((item) => ({
    type: "CANNY" as const, inputName: `control_${item.position}`, strength: 1, startPercent: 0, endPercent: 1,
  }));
  try {
    return executionParametersSchema.parse({
      kind: input.type, ...value, negativePrompt: value.negativePrompt ?? "", seed: value.seed ?? fallbackSeed,
      sampler: "dpmpp_2m", scheduler: "karras", controls, outputFormat: "png",
    });
  } catch (error) {
    throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Stored render parameters are not executable.", false, { cause: error });
  }
}
