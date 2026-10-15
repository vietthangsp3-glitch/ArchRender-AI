import { describe, expect, it } from "vitest";

import { assertUploadCapacity } from "../src/quota.js";

const policy = {
  initiateRatePerMinute: 3,
  maxConcurrentUploads: 2,
  ownerQuotaBytes: 1_000,
};

describe("owner upload capacity", () => {
  it("accepts a reservation within every limit", () => {
    expect(() => assertUploadCapacity({
      recentInitiatedUploads: 1,
      concurrentUploads: 1,
      reservedBytes: 500n,
    }, 500, policy)).not.toThrow();
  });

  it.each([
    [{ recentInitiatedUploads: 3, concurrentUploads: 0, reservedBytes: 0n }, 1, "ASSET_RATE_LIMITED"],
    [{ recentInitiatedUploads: 0, concurrentUploads: 2, reservedBytes: 0n }, 1, "ASSET_CONCURRENT_LIMIT"],
    [{ recentInitiatedUploads: 0, concurrentUploads: 0, reservedBytes: 901n }, 100, "ASSET_QUOTA_EXCEEDED"],
  ] as const)("rejects exhausted capacity", (snapshot, bytes, code) => {
    expect(() => assertUploadCapacity(snapshot, bytes, policy)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
