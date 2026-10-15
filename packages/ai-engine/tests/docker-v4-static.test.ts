import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compileWorkflow, modelManifestSchema } from "../src";

const root = resolve(import.meta.dirname, "../../../ai-engine/arch-ai-cloud-v4");

describe("Docker V4 static security contract", () => {
  it("keeps every unverified model fail-closed", async () => {
    const manifest = modelManifestSchema.parse(JSON.parse(await readFile(resolve(root, "config/models.manifest.json"), "utf8")));
    expect(manifest.models.every((model) => model.status !== "READY")).toBe(true);
    expect(manifest.models.flatMap((model) => model.artifacts).every((artifact) => artifact.status === "PENDING_VERIFICATION")).toBe(true);
    expect(manifest.models.find((model) => model.id === "architecture_video_wan22")?.status).toBe("DISABLED");
  });

  it("does not expose ComfyUI and hardens both containers", async () => {
    const compose = await readFile(resolve(root, "docker-compose.yml"), "utf8");
    const comfyService = compose.split("\n  ai-gateway:")[0];
    expect(comfyService).not.toContain("\n    ports:");
    expect(compose).toContain("127.0.0.1");
    expect(compose.match(/^    read_only: true$/gm)).toHaveLength(2);
    expect(compose.match(/no-new-privileges:true/g)).toHaveLength(2);
    expect(compose).toContain("internal: true");
    expect(compose).toContain("engine_state");
  });

  it("disables paid API nodes and runtime model downloads", async () => {
    const start = await readFile(resolve(root, "scripts/start-comfyui.sh"), "utf8");
    const dockerfile = await readFile(resolve(root, "Dockerfile.comfyui"), "utf8");
    expect(start).toContain("--disable-api-nodes");
    expect(dockerfile).not.toMatch(/download-model|huggingface-cli|wget .*safetensors/i);
  });

  it("pins the runtime and keeps the acceptance harness fail-closed", async () => {
    const runtime = JSON.parse(await readFile(resolve(root, "config/runtime-manifest.json"), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(runtime)).toContain("ee71d5c4993f29086b27fde1629a945ae48425bf");
    const harness = await readFile(resolve(root, "scripts/gpu-image-acceptance.mjs"), "utf8");
    expect(harness).toContain("PHASE3_IMAGE_ACCEPTANCE_APPROVED");
    expect(harness).toContain("maxRuntimeMinutes");
    expect(harness).toContain('execFileSync("docker"');
    expect(harness).toContain('"compose"');
    expect(harness).not.toMatch(/Write-(?:Host|Output).*TOKEN/i);
  });

  it("pins the synthetic architectural fixtures used by the GPU plan", async () => {
    const criteria = JSON.parse(await readFile(resolve(root, "fixtures/golden-courtyard.criteria.json"), "utf8")) as {
      containsPersonalData: boolean;
      inputs: Array<{ file: string; sizeBytes: number; sha256: string }>;
    };
    expect(criteria.containsPersonalData).toBe(false);
    expect(criteria.inputs).toHaveLength(3);
    for (const input of criteria.inputs) {
      const bytes = await readFile(resolve(root, "fixtures", input.file));
      expect(bytes.byteLength).toBe(input.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.sha256);
    }
  });

  it("compiles the pinned Canny/Depth and upscale artifacts using core nodes", async () => {
    const manifest = modelManifestSchema.parse(JSON.parse(await readFile(resolve(root, "config/models.manifest.json"), "utf8")));
    const control = structuredClone(manifest.models.find((model) => model.id === "architecture_image_sdxl_control"));
    const upscale = structuredClone(manifest.models.find((model) => model.id === "architecture_upscale_realesrgan_x4plus"));
    expect(control).toBeDefined(); expect(upscale).toBeDefined();
    control!.status = "READY"; control!.artifacts.forEach((artifact) => { artifact.status = "VERIFIED"; });
    upscale!.status = "READY"; upscale!.artifacts.forEach((artifact) => { artifact.status = "VERIFIED"; });
    const common = { prompt: "architecture", negativePrompt: "", width: 1024, height: 1024, steps: 20,
      guidance: 6, strength: 0.4, seed: 1, sampler: "dpmpp_2m" as const, scheduler: "karras" as const, outputFormat: "png" as const };
    const image = compileWorkflow({ model: control!, outputPrefix: "acceptance_1234",
      inputFiles: { source: "source.png", canny: "canny.png", depth: "depth.png" },
      parameters: { kind: "IMAGE_RENDER", ...common, controls: [
        { type: "CANNY", inputName: "canny", strength: 0.8, startPercent: 0, endPercent: 0.8 },
        { type: "DEPTH", inputName: "depth", strength: 0.7, startPercent: 0, endPercent: 0.8 },
      ] },
    });
    expect(Object.values(image.prompt).filter((node) => node.class_type === "ControlNetLoader")).toHaveLength(2);
    const upscaled = compileWorkflow({ model: upscale!, outputPrefix: "acceptance_5678", inputFiles: { source: "source.png" },
      parameters: { kind: "IMAGE_UPSCALE", ...common, controls: [] } });
    expect(Object.values(upscaled.prompt).some((node) => node.class_type === "ImageUpscaleWithModel")).toBe(true);
  });
});
