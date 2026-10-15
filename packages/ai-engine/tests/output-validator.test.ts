import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { validateEngineOutput } from "../src";

const policy = { maxBytes: 1024, maxWidth: 4096, maxHeight: 4096, maxPixels: 16_000_000, maxDurationSeconds: 10, maxFrameRate: 30 };

describe("engine output validation", () => {
  it("binds decoded metadata, magic bytes and sha256", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const result = await validateEngineOutput(bytes, "image/png", policy, async () => ({
      format: "png", width: 1, height: 1, hasVideoStream: true,
    }));
    expect(result.checksumSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("rejects declared content type and probe mismatches", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await expect(validateEngineOutput(bytes, "video/mp4", policy, async () => ({
      format: "png", width: 1, height: 1, hasVideoStream: true,
    }))).rejects.toThrow(/bounded media/i);
  });
});
