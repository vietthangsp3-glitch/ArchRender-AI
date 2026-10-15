import { describe, expect, it } from "vitest";

import {
  assertMagicBytes,
  detectImageMime,
  sanitizeFilename,
  validateUploadIntent,
} from "../src/policy.js";

describe("asset upload policy", () => {
  it("accepts a matching allowlisted MIME and extension", () => {
    expect(validateUploadIntent({
      assetType: "SOURCE_IMAGE",
      originalName: "living-room.JPEG",
      declaredContentType: "image/jpeg",
      declaredByteSize: 1_024,
    }, { maxUploadBytes: 2_048 })).toMatchObject({
      contentType: "image/jpeg",
      extension: ".jpeg",
      sanitizedName: "living-room.JPEG",
    });
  });

  it.each([
    ["image/svg+xml", "drawing.svg"],
    ["application/octet-stream", "drawing.png"],
    ["image/png", "drawing.jpg"],
    ["image/webp", "drawing.webp.exe"],
  ])("rejects MIME/extension combination %s / %s", (declaredContentType, originalName) => {
    expect(() => validateUploadIntent({
      assetType: "REFERENCE_IMAGE",
      originalName,
      declaredContentType,
      declaredByteSize: 100,
    } as Parameters<typeof validateUploadIntent>[0], { maxUploadBytes: 1_000 })).toThrow();
  });

  it("rejects oversized declared files", () => {
    expect(() => validateUploadIntent({
      assetType: "DEPTH_MAP",
      originalName: "depth.png",
      declaredContentType: "image/png",
      declaredByteSize: 1_001,
    }, { maxUploadBytes: 1_000 })).toThrow("upload limit");
  });

  it("removes paths and unsafe filename characters", () => {
    expect(sanitizeFilename("..\\private/floor\u0000 plan<>.png")).toBe("floor plan__.png");
  });

  it("detects supported magic bytes and rejects MIME spoofing", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]);
    const webp = Buffer.from("RIFF0000WEBP", "ascii");
    expect(detectImageMime(png)).toBe("image/png");
    expect(detectImageMime(jpeg)).toBe("image/jpeg");
    expect(detectImageMime(webp)).toBe("image/webp");
    expect(() => assertMagicBytes(png, "image/jpeg")).toThrow("signature");
  });
});
