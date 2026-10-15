import { createHash } from "node:crypto";

import { AiEngineError } from "./errors";
import type { ModelDefinition } from "./model-manifest";
import { executionParametersSchema, type ExecutionParameters } from "./schemas";

type InputValue = string | number | boolean | [string, number];
export interface ComfyNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta: { title: string };
}
export type ComfyPrompt = Record<string, ComfyNode>;

const ALLOWED_NODE_CLASSES = new Set([
  "CheckpointLoaderSimple", "CLIPTextEncode", "LoadImage", "VAEEncode", "KSampler",
  "VAEDecode", "SaveImage", "ControlNetLoader", "ControlNetApplyAdvanced",
  "ImageScale", "UpscaleModelLoader", "ImageUpscaleWithModel", "WanImageToVideo",
  "CreateVideo", "SaveVideo",
]);

function assertSafeScalar(value: InputValue): void {
  if (typeof value !== "string") return;
  if (value.includes("\0") || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) || /^https?:\/\//i.test(value)) {
    throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Unsafe workflow scalar.");
  }
}

export interface CompileWorkflowInput {
  parameters: unknown;
  model: ModelDefinition;
  inputFiles: Readonly<Record<string, string>>;
  outputPrefix: string;
}

export interface CompiledWorkflow {
  prompt: ComfyPrompt;
  promptHash: string;
  jobType: ExecutionParameters["kind"];
  expectedOutput: "IMAGE" | "VIDEO";
}

export function compileWorkflow(input: CompileWorkflowInput): CompiledWorkflow {
  const parameters = executionParametersSchema.parse(input.parameters);
  if (!input.model.jobTypes.includes(parameters.kind)) {
    throw new AiEngineError("AI_ENGINE_CAPABILITY_MISSING", "Model and job type do not match.");
  }
  if (!/^[a-z0-9_-]{8,120}$/.test(input.outputPrefix)) {
    throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Unsafe output prefix.");
  }
  const sourceFile = input.inputFiles.source ?? input.inputFiles.start_frame;
  if (!sourceFile || !/^[A-Za-z0-9_.-]{1,180}$/.test(sourceFile)) {
    throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "A staged local input filename is required.");
  }

  const prompt: ComfyPrompt = parameters.kind === "IMAGE_TO_VIDEO"
    ? compileVideo(parameters, sourceFile, input.outputPrefix, input.model)
    : parameters.kind === "IMAGE_UPSCALE"
      ? compileUpscale(sourceFile, input.outputPrefix, input.model)
      : compileImage(parameters, sourceFile, input.outputPrefix, input.model, input.inputFiles);
  validateCompiledPrompt(prompt, new Set(input.model.requiredNodeClasses));
  const serialized = stableJson(prompt);
  return {
    prompt,
    promptHash: createHash("sha256").update(serialized).digest("hex"),
    jobType: parameters.kind,
    expectedOutput: parameters.kind === "IMAGE_TO_VIDEO" ? "VIDEO" : "IMAGE",
  };
}

function compileImage(
  value: Exclude<ExecutionParameters, { kind: "IMAGE_TO_VIDEO" }>,
  sourceFile: string,
  outputPrefix: string,
  model: ModelDefinition,
  inputFiles: Readonly<Record<string, string>>,
): ComfyPrompt {
  const checkpoint = model.artifacts.find((artifact) => artifact.relativePath.startsWith("checkpoints/"));
  if (!checkpoint) throw new AiEngineError("AI_ENGINE_MODEL_UNAVAILABLE", "Checkpoint artifact is missing.");
  const prompt: ComfyPrompt = {
    "1": node("LoadImage", { image: sourceFile }, "Verified source"),
    "2": node("CheckpointLoaderSimple", { ckpt_name: checkpoint.relativePath.replace("checkpoints/", "") }, "Pinned checkpoint"),
    "3": node("CLIPTextEncode", { text: value.prompt, clip: ["2", 1] }, "Positive prompt"),
    "4": node("CLIPTextEncode", { text: value.negativePrompt, clip: ["2", 1] }, "Negative prompt"),
    "5": node("VAEEncode", { pixels: ["1", 0], vae: ["2", 2] }, "Encode source"),
  };
  let positive: [string, number] = ["3", 0];
  let negative: [string, number] = ["4", 0];
  value.controls.forEach((control, index) => {
    const filename = inputFiles[control.inputName];
    if (!filename || !/^[A-Za-z0-9_.-]{1,180}$/.test(filename)) {
      throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Control input is unavailable.");
    }
    const imageId = String(20 + index * 3);
    const loaderId = String(21 + index * 3);
    const applyId = String(22 + index * 3);
    const controlArtifact = model.artifacts.find((artifact) => artifact.relativePath.toLowerCase().includes("controlnet") && artifact.relativePath.toLowerCase().includes(control.type.toLowerCase()));
    if (!controlArtifact) throw new AiEngineError("AI_ENGINE_MODEL_UNAVAILABLE", "Verified control model artifact is missing.");
    prompt[imageId] = node("LoadImage", { image: filename }, `${control.type} control`);
    prompt[loaderId] = node("ControlNetLoader", { control_net_name: controlArtifact.relativePath.replace("controlnet/", "") }, `${control.type} model`);
    prompt[applyId] = node("ControlNetApplyAdvanced", {
      positive, negative, control_net: [loaderId, 0], image: [imageId, 0], strength: control.strength,
      start_percent: control.startPercent, end_percent: control.endPercent,
    }, `${control.type} conditioning`);
    positive = [applyId, 0];
    negative = [applyId, 1];
  });
  prompt["6"] = node("KSampler", {
    model: ["2", 0], positive, negative, latent_image: ["5", 0], seed: value.seed, steps: value.steps,
    cfg: value.guidance, sampler_name: value.sampler, scheduler: value.scheduler, denoise: value.strength,
  }, "Bounded sampler");
  prompt["7"] = node("VAEDecode", { samples: ["6", 0], vae: ["2", 2] }, "Decode output");
  prompt["8"] = node("SaveImage", { images: ["7", 0], filename_prefix: outputPrefix }, "Private output");
  return prompt;
}

function compileUpscale(sourceFile: string, outputPrefix: string, model: ModelDefinition): ComfyPrompt {
  const artifact = model.artifacts.find((candidate) => candidate.relativePath.startsWith("upscale_models/"));
  if (!artifact) throw new AiEngineError("AI_ENGINE_MODEL_UNAVAILABLE", "Upscale artifact is missing.");
  return {
    "1": node("LoadImage", { image: sourceFile }, "Verified source"),
    "2": node("UpscaleModelLoader", { model_name: artifact.relativePath.replace("upscale_models/", "") }, "Pinned upscale model"),
    "3": node("ImageUpscaleWithModel", { upscale_model: ["2", 0], image: ["1", 0] }, "Bounded upscale"),
    "4": node("SaveImage", { images: ["3", 0], filename_prefix: outputPrefix }, "Private output"),
  };
}

function compileVideo(
  value: Extract<ExecutionParameters, { kind: "IMAGE_TO_VIDEO" }>,
  sourceFile: string,
  outputPrefix: string,
  model: ModelDefinition,
): ComfyPrompt {
  const modelArtifact = model.artifacts[0];
  if (!modelArtifact) throw new AiEngineError("AI_ENGINE_MODEL_UNAVAILABLE", "Video model artifact is missing.");
  return {
    "1": node("LoadImage", { image: sourceFile }, "Verified start frame"),
    "2": node("WanImageToVideo", {
      image: ["1", 0], model_name: modelArtifact.relativePath, prompt: value.prompt,
      negative_prompt: value.negativePrompt, width: value.width, height: value.height,
      length: value.frames, steps: value.steps, cfg: value.guidance, seed: value.seed,
    }, "Bounded video generation"),
    "3": node("CreateVideo", { images: ["2", 0], fps: value.fps }, "Create MP4"),
    "4": node("SaveVideo", { video: ["3", 0], filename_prefix: outputPrefix, format: "mp4" }, "Private output"),
  };
}

function node(classType: string, inputs: Record<string, InputValue>, title: string): ComfyNode {
  return { class_type: classType, inputs, _meta: { title } };
}

export function validateCompiledPrompt(prompt: ComfyPrompt, requiredClasses = new Set<string>()): void {
  const entries = Object.entries(prompt);
  if (entries.length < 1 || entries.length > 96) throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Workflow node count is invalid.");
  const present = new Set<string>();
  for (const [id, current] of entries) {
    if (!/^\d{1,4}$/.test(id) || !ALLOWED_NODE_CLASSES.has(current.class_type)) {
      throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Workflow contains a forbidden node.");
    }
    present.add(current.class_type);
    Object.values(current.inputs).forEach(assertSafeScalar);
  }
  if ([...requiredClasses].some((nodeClass) => !present.has(nodeClass))) {
    throw new AiEngineError("AI_ENGINE_CAPABILITY_MISSING", "Compiled workflow omits a required node capability.");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
