import sharp from "sharp";

import { AssetApplicationError } from "./errors";
import { assertMagicBytes, type ImageMimeType } from "./policy";
import type { InspectedImage, SupportedImageFormat } from "./types";

export interface ImageInspectionPolicy {
  maxUploadBytes: number;
  maxImageDimension: number;
  maxDecodedPixels: number;
}

const CONTENT_TYPE_BY_FORMAT = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export async function inspectImage(
  bytes: Uint8Array,
  expectedContentType: ImageMimeType,
  policy: ImageInspectionPolicy,
): Promise<InspectedImage> {
  if (bytes.byteLength === 0 || bytes.byteLength > policy.maxUploadBytes) {
    throw new AssetApplicationError("ASSET_INVALID_INPUT", "Image content exceeds the bounded inspection limit.");
  }
  assertMagicBytes(bytes, expectedContentType);
  try {
    const metadata = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: policy.maxDecodedPixels,
      sequentialRead: true,
    }).metadata();
    const format = metadata.format as SupportedImageFormat | undefined;
    const width = metadata.width;
    const height = metadata.height;
    if (!format || !(format in CONTENT_TYPE_BY_FORMAT) || !width || !height) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Unsupported or incomplete image metadata.");
    }
    if (CONTENT_TYPE_BY_FORMAT[format] !== expectedContentType) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Decoded image format does not match content type.");
    }
    if (width > policy.maxImageDimension || height > policy.maxImageDimension) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Image dimensions exceed the configured limit.");
    }
    if (width * height > policy.maxDecodedPixels) {
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Decoded pixel count exceeds the configured limit.");
    }
    return { format, contentType: CONTENT_TYPE_BY_FORMAT[format], width, height, byteSize: bytes.byteLength };
  } catch (error) {
    if (error instanceof AssetApplicationError) throw error;
    throw new AssetApplicationError("ASSET_INVALID_INPUT", "Image decoding failed.", false, { cause: error });
  }
}
