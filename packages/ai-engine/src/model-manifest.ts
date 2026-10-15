import { z } from "zod";

import { AiEngineError } from "./errors";

const artifactSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,180}$/),
  relativePath: z.string().regex(/^[A-Za-z0-9_./-]{1,512}$/).refine((value) => !value.includes("..")),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sourceUrl: z.string().url().nullable(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  sizeBytes: z.number().int().positive().nullable(),
  license: z.string().max(200).nullable(),
  licenseUrl: z.string().url().nullable(),
  commercialUse: z.enum(["PERMITTED", "PERMITTED_WITH_RESTRICTIONS", "UNKNOWN"]),
  status: z.enum(["VERIFIED", "PENDING_VERIFICATION"]),
}).strict().superRefine((value, context) => {
  if (value.status === "VERIFIED" && (!value.sha256 || !value.sourceUrl || !value.sourceRevision ||
      !value.sizeBytes || !value.license || !value.licenseUrl || value.commercialUse === "UNKNOWN")) {
    context.addIssue({ code: "custom", message: "Verified artifacts require pinned source, size, checksum and license evidence." });
  }
});

const modelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,80}$/),
  revision: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  status: z.enum(["READY", "PENDING_VERIFICATION", "DISABLED"]),
  jobTypes: z.array(z.enum(["IMAGE_RENDER", "IMAGE_UPSCALE", "IMAGE_TO_VIDEO"])).min(1),
  requiredNodeClasses: z.array(z.string().regex(/^[A-Za-z0-9_]{1,120}$/)).max(64),
  estimatedVramMb: z.number().int().min(512).max(196_608),
  artifacts: z.array(artifactSchema).min(1),
}).strict();

export const modelManifestSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime(),
  models: z.array(modelSchema).min(1),
}).strict();

export type ModelManifest = z.infer<typeof modelManifestSchema>;
export type ModelDefinition = ModelManifest["models"][number];

export function resolveReadyModel(
  manifest: ModelManifest,
  modelId: string,
  jobType: ModelDefinition["jobTypes"][number],
  availableNodeClasses: ReadonlySet<string>,
): ModelDefinition {
  const model = manifest.models.find((candidate) => candidate.id === modelId);
  if (!model || model.status !== "READY" || model.artifacts.some((artifact) => artifact.status !== "VERIFIED")) {
    throw new AiEngineError("AI_ENGINE_MODEL_UNAVAILABLE", "Requested model is not verified and ready.");
  }
  if (!model.jobTypes.includes(jobType)) {
    throw new AiEngineError("AI_ENGINE_CAPABILITY_MISSING", "Model does not support this job type.");
  }
  const missing = model.requiredNodeClasses.filter((nodeClass) => !availableNodeClasses.has(nodeClass));
  if (missing.length > 0) {
    throw new AiEngineError("AI_ENGINE_CAPABILITY_MISSING", "Required engine node capability is unavailable.");
  }
  return model;
}
