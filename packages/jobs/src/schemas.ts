import { z } from "zod";

const uuid = z.string().uuid();
const safeName = z.string().trim().min(1).max(180);
const safeDescription = z.string().trim().max(2_000).optional();

export const imageParametersSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  negativePrompt: z.string().trim().max(2_000).optional(),
  strength: z.number().min(0).max(1).default(0.75),
  steps: z.number().int().min(1).max(100).default(30),
  guidance: z.number().min(1).max(30).default(7),
  width: z.number().int().min(256).max(4096).multipleOf(8),
  height: z.number().int().min(256).max(4096).multipleOf(8),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
}).strict();

export const videoParametersSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  durationSeconds: z.number().int().min(1).max(10),
  fps: z.number().int().min(8).max(30),
  motion: z.enum(["STATIC", "PAN_LEFT", "PAN_RIGHT", "DOLLY_IN", "DOLLY_OUT", "ORBIT"]),
  quality: z.enum(["DRAFT", "STANDARD", "HIGH"]),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
}).strict();

export const workflowConfigurationSchema = z.object({
  backend: z.enum(["COMFYUI_IMAGE", "WAN_VIDEO"]),
  kind: z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE", "IMAGE_TO_VIDEO"]),
  parameterSchemaVersion: z.literal("1"),
  modelFamily: z.string().trim().min(3).max(80).regex(/^[a-z0-9][a-z0-9_-]+$/),
  conditioning: z.array(z.enum(["IMAGE", "CANNY", "DEPTH", "NORMAL"])).max(4),
}).strict();

export const createWorkflowSchema = z.object({
  projectId: uuid.optional(),
  name: safeName,
  description: safeDescription,
  kind: z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE", "IMAGE_TO_VIDEO"]),
  parameterSchemaVersion: z.literal("1").default("1"),
  configuration: workflowConfigurationSchema,
}).strict();

export const updateWorkflowSchema = z.object({
  name: safeName.optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  configuration: workflowConfigurationSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required.");

export const submitJobSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/),
  projectId: uuid,
  workflowVersionId: uuid,
  type: z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE", "IMAGE_TO_VIDEO"]),
  priority: z.number().int().min(-10).max(10).default(0),
  maxRetries: z.number().int().min(0).max(5).default(2),
  inputs: z.array(z.object({
    assetId: uuid,
    role: z.enum(["SOURCE_IMAGE", "START_FRAME", "CONTROL_IMAGE"]),
    position: z.number().int().min(0).max(32).default(0),
  }).strict()).min(1).max(8),
  parameters: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, context) => {
  const sourceCount = value.inputs.filter((input) => input.role === "SOURCE_IMAGE").length;
  const frameCount = value.inputs.filter((input) => input.role === "START_FRAME").length;
  if (value.type === "IMAGE_TO_VIDEO") {
    if (frameCount !== 1 || value.inputs.length !== 1) context.addIssue({ code: "custom", path: ["inputs"], message: "Video jobs require exactly one START_FRAME." });
  } else if (sourceCount !== 1 || frameCount !== 0) {
    context.addIssue({ code: "custom", path: ["inputs"], message: "Image jobs require exactly one SOURCE_IMAGE and optional CONTROL_IMAGE inputs." });
  }
});

export const listJobsSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  projectId: uuid.optional(),
  type: z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE", "IMAGE_TO_VIDEO"]).optional(),
  status: z.enum([
    "CREATED", "UPLOADING", "QUEUED", "CLAIMED", "PROVISIONING", "RUNNING",
    "CANCEL_REQUESTED", "RETRY_SCHEDULED", "SUCCEEDED", "FAILED", "CANCELLED",
  ]).optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  search: z.string().trim().max(100).optional(),
}).strict();

export const listWorkflowsSchema = z.object({
  kind: z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE", "IMAGE_TO_VIDEO"]).optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
}).strict();

export const idSchema = uuid;

export function validateJobParameters(type: "IMAGE_RENDER" | "IMAGE_UPSCALE" | "IMAGE_TO_VIDEO", value: unknown) {
  return type === "IMAGE_TO_VIDEO"
    ? videoParametersSchema.parse(value)
    : imageParametersSchema.parse(value);
}
