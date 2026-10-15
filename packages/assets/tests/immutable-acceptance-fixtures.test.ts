import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createImmutableAcceptanceFixtures } from "../scripts/immutable-acceptance-fixtures.js";

describe("real R2 immutable acceptance fixtures", () => {
  it("creates valid, equal-length PNGs with different content and SHA-256", async () => {
    const fixtures = await createImmutableAcceptanceFixtures();
    const [mainMetadata, replayMetadata] = await Promise.all([
      sharp(fixtures.main).metadata(),
      sharp(fixtures.replay).metadata(),
    ]);

    expect(fixtures.main.byteLength).toBe(fixtures.replay.byteLength);
    expect(fixtures.main.equals(fixtures.replay)).toBe(false);
    expect(fixtures.mainChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtures.replayChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtures.mainChecksum).not.toBe(fixtures.replayChecksum);
    expect(mainMetadata).toMatchObject({ format: "png", width: 32, height: 24 });
    expect(replayMetadata).toMatchObject({ format: "png", width: 32, height: 24 });
  });

  it("is deterministic so validation can finish before any mutation", async () => {
    const first = await createImmutableAcceptanceFixtures();
    const second = await createImmutableAcceptanceFixtures();

    expect(second.mainChecksum).toBe(first.mainChecksum);
    expect(second.replayChecksum).toBe(first.replayChecksum);
    expect(second.main.byteLength).toBe(first.main.byteLength);
  });
});
