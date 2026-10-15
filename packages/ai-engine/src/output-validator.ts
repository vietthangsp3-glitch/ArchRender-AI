import { createHash } from "node:crypto";

import { AiEngineError } from "./errors";

export interface MediaProbeResult {
  format: "png" | "jpeg" | "webp" | "mp4";
  width: number;
  height: number;
  durationSeconds?: number;
  frameRate?: number;
  hasVideoStream: boolean;
}

export interface OutputValidationPolicy {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  maxDurationSeconds: number;
  maxFrameRate: number;
}

export interface ValidatedOutput {
  checksumSha256: string;
  byteSize: number;
  contentType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  width: number;
  height: number;
  durationSeconds?: number;
}

const mimeByFormat = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
} as const;

export async function validateEngineOutput(
  bytes: Uint8Array,
  declaredContentType: string,
  policy: OutputValidationPolicy,
  probe: (bytes: Uint8Array) => Promise<MediaProbeResult>,
): Promise<ValidatedOutput> {
  if (bytes.byteLength < 12 || bytes.byteLength > policy.maxBytes) invalid();
  const media = await probe(bytes).catch((error: unknown) => {
    throw new AiEngineError("AI_ENGINE_OUTPUT_INVALID", "Output media probe failed.", false, { cause: error });
  });
  const contentType = mimeByFormat[media.format];
  if (declaredContentType !== contentType || !matchesMagic(bytes, media.format)) invalid();
  if (!Number.isInteger(media.width) || !Number.isInteger(media.height) || media.width < 1 || media.height < 1 ||
      media.width > policy.maxWidth || media.height > policy.maxHeight || media.width * media.height > policy.maxPixels) invalid();
  if (!media.hasVideoStream) invalid();
  if (media.format === "mp4") {
    if (!media.durationSeconds || media.durationSeconds <= 0 || media.durationSeconds > policy.maxDurationSeconds ||
        !media.frameRate || media.frameRate <= 0 || media.frameRate > policy.maxFrameRate) invalid();
  }
  return {
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    contentType,
    width: media.width,
    height: media.height,
    ...(media.durationSeconds === undefined ? {} : { durationSeconds: media.durationSeconds }),
  };
}

function matchesMagic(bytes: Uint8Array, format: MediaProbeResult["format"]): boolean {
  if (format === "png") return bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (format === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (format === "webp") return text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 12) === "WEBP";
  return text(bytes, 4, 8) === "ftyp";
}

function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function invalid(): never {
  throw new AiEngineError("AI_ENGINE_OUTPUT_INVALID", "Generated output violates the bounded media contract.");
}
