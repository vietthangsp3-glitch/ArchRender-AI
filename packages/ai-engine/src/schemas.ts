import { z } from "zod";

const prompt = z.string().trim().min(1).max(2_000);
const seed = z.number().int().min(0).max(2_147_483_647);
const boundedDimension = z.number().int().min(256).max(4096).multipleOf(8);

export const imageExecutionSchema = z.object({
  kind: z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE"]),
  prompt,
  negativePrompt: z.string().trim().max(2_000).default(""),
  width: boundedDimension,
  height: boundedDimension,
  steps: z.number().int().min(1).max(100),
  guidance: z.number().min(1).max(30),
  strength: z.number().min(0).max(1),
  seed,
  sampler: z.enum(["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_sde"]),
  scheduler: z.enum(["normal", "karras", "sgm_uniform"]),
  controls: z.array(z.object({
    type: z.enum(["CANNY", "DEPTH", "NORMAL"]),
    inputName: z.string().regex(/^[a-z0-9_-]{1,80}$/),
    strength: z.number().min(0).max(2),
    startPercent: z.number().min(0).max(1),
    endPercent: z.number().min(0).max(1),
  }).strict().refine((value) => value.startPercent <= value.endPercent, "Invalid control range.")).max(3),
  outputFormat: z.enum(["png", "webp"]).default("png"),
}).strict();

export const videoExecutionSchema = z.object({
  kind: z.literal("IMAGE_TO_VIDEO"),
  prompt,
  negativePrompt: z.string().trim().max(2_000).default(""),
  width: z.number().int().min(256).max(1920).multipleOf(16),
  height: z.number().int().min(256).max(1088).multipleOf(16),
  frames: z.number().int().min(8).max(241),
  fps: z.number().int().min(8).max(30),
  steps: z.number().int().min(1).max(80),
  guidance: z.number().min(1).max(20),
  seed,
  startFrameInputName: z.string().regex(/^[a-z0-9_-]{1,80}$/),
  outputFormat: z.literal("mp4"),
}).strict().refine((value) => value.frames / value.fps <= 10, "Video duration exceeds 10 seconds.");

export const executionParametersSchema = z.discriminatedUnion("kind", [
  imageExecutionSchema,
  videoExecutionSchema,
]);

export const resourceBudgetSchema = z.object({
  timeoutMs: z.number().int().min(5_000).max(30 * 60_000),
  pollIntervalMs: z.number().int().min(250).max(10_000),
  maxOutputBytes: z.number().int().min(1).max(512 * 1024 * 1024),
  maxEstimatedVramMb: z.number().int().min(512).max(196_608),
  maxAttempts: z.number().int().min(1).max(3),
}).strict();

export type ExecutionParameters = z.infer<typeof executionParametersSchema>;
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;
