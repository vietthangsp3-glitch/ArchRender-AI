import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { validateEngineOutput, type MediaProbeResult, type OutputValidationPolicy } from "@archrender/ai-engine";
import { inspectImage, type AssetStorageConfig, type GeneratedMediaInspector } from "@archrender/assets";
import { z } from "zod";

const execute = promisify(execFile);
const ffprobeSchema = z.object({ streams: z.array(z.object({
  codec_type: z.string(), width: z.number().int().optional(), height: z.number().int().optional(),
  avg_frame_rate: z.string().optional(),
}).passthrough()), format: z.object({ duration: z.string() }).passthrough() }).passthrough();

export class BoundedGeneratedMediaInspector implements GeneratedMediaInspector {
  private readonly policy: OutputValidationPolicy;
  constructor(private readonly config: AssetStorageConfig, private readonly ffprobePath = "ffprobe") {
    this.policy = { maxBytes: config.maxUploadBytes, maxWidth: config.maxImageDimension, maxHeight: config.maxImageDimension, maxPixels: config.maxDecodedPixels, maxDurationSeconds: 10, maxFrameRate: 30 };
  }
  async inspect(bytes: Uint8Array, declaredContentType: string) {
    const validated = await validateEngineOutput(bytes, declaredContentType, this.policy, async (content) =>
      declaredContentType === "video/mp4" ? this.probeVideo(content) : this.probeImage(content, declaredContentType));
    return validated;
  }
  private async probeImage(bytes: Uint8Array, contentType: string): Promise<MediaProbeResult> {
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType)) throw new Error("UNSUPPORTED_IMAGE_TYPE");
    const result = await inspectImage(bytes, contentType as "image/png" | "image/jpeg" | "image/webp", this.config);
    return { format: result.format, width: result.width, height: result.height, hasVideoStream: true };
  }
  private async probeVideo(bytes: Uint8Array): Promise<MediaProbeResult> {
    const directory = await mkdtemp(join(tmpdir(), "archrender-probe-"));
    const path = join(directory, `${createHash("sha256").update(bytes).digest("hex")}.mp4`);
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      const { stdout } = await execute(this.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { timeout: 15_000, maxBuffer: 512 * 1024, windowsHide: true });
      const result = ffprobeSchema.parse(JSON.parse(stdout));
      const video = result.streams.find((stream) => stream.codec_type === "video");
      const [numerator, denominator] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
      return { format: "mp4", width: video?.width ?? 0, height: video?.height ?? 0, durationSeconds: Number(result.format.duration), frameRate: denominator ? (numerator ?? 0) / denominator : 0, hasVideoStream: Boolean(video) };
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  }
}
