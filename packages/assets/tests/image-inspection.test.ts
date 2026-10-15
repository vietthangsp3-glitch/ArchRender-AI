import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { inspectImage } from "../src/image-inspection.js";

const policy = {
  maxUploadBytes: 1_000_000,
  maxImageDimension: 128,
  maxDecodedPixels: 16_384,
};

describe("bounded image inspection", () => {
  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const)("decodes %s metadata", async (format, contentType) => {
    const bytes = await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#334455" },
    }).toFormat(format).toBuffer();
    await expect(inspectImage(bytes, contentType, policy)).resolves.toMatchObject({
      format,
      contentType,
      width: 32,
      height: 24,
    });
  });

  it("rejects dimensions above the configured limit", async () => {
    const bytes = await sharp({
      create: { width: 129, height: 8, channels: 3, background: "white" },
    }).png().toBuffer();
    await expect(inspectImage(bytes, "image/png", policy)).rejects.toThrow("dimensions");
  });

  it("rejects a buffer above the bounded read limit before decoding", async () => {
    await expect(inspectImage(new Uint8Array(9), "image/png", {
      ...policy,
      maxUploadBytes: 8,
    })).rejects.toThrow("bounded inspection");
  });
});
