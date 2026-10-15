import { extname } from "node:path";

import { AssetApplicationError } from "./errors";
import { UPLOAD_ASSET_TYPES, type UploadAssetType } from "./types";

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

const EXTENSIONS_BY_MIME: Record<ImageMimeType, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

export interface UploadIntent {
  assetType: UploadAssetType;
  originalName: string;
  declaredContentType: string;
  declaredByteSize: number;
}

export interface UploadPolicy {
  maxUploadBytes: number;
}

function invalid(message: string): never {
  throw new AssetApplicationError("ASSET_INVALID_INPUT", message);
}

export function sanitizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1) ?? "";
  const clean = basename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return clean || "upload";
}

export function validateUploadIntent(input: UploadIntent, policy: UploadPolicy) {
  if (!UPLOAD_ASSET_TYPES.includes(input.assetType)) invalid("Unsupported asset type.");
  if (!Number.isSafeInteger(input.declaredByteSize) || input.declaredByteSize <= 0) {
    invalid("File size must be a positive integer.");
  }
  if (input.declaredByteSize > policy.maxUploadBytes) invalid("File exceeds the upload limit.");
  if (!IMAGE_MIME_TYPES.includes(input.declaredContentType as ImageMimeType)) {
    invalid("Unsupported declared content type.");
  }
  const contentType = input.declaredContentType as ImageMimeType;
  const sanitizedName = sanitizeFilename(input.originalName);
  const extension = extname(sanitizedName).toLowerCase();
  if (!EXTENSIONS_BY_MIME[contentType].includes(extension)) {
    invalid("Filename extension does not match the declared content type.");
  }
  return { ...input, contentType, sanitizedName, extension };
}

export function detectImageMime(bytes: Uint8Array): ImageMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

export function assertMagicBytes(bytes: Uint8Array, expected: ImageMimeType): void {
  const actual = detectImageMime(bytes);
  if (!actual || actual !== expected) invalid("Image signature does not match the declared content type.");
}
