import { describe, expect, it } from "vitest";

import { isUploadExpired, transitionAssetStatus } from "../src/lifecycle.js";
import { createAssetObjectKey } from "../src/object-key.js";

describe("private object key strategy", () => {
  it("creates an environment and owner-scoped key without a filename", () => {
    const key = createAssetObjectKey({
      environment: "development",
      ownerId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      assetId: "00000000-0000-4000-8000-000000000003",
      randomId: "0123456789abcdef0123456789abcdef",
    });
    expect(key).toBe(
      "development/owners/00000000-0000-4000-8000-000000000001/" +
      "projects/00000000-0000-4000-8000-000000000002/" +
      "assets/00000000-0000-4000-8000-000000000003/0123456789abcdef0123456789abcdef",
    );
    expect(key).not.toContain(".png");
  });

  it("rejects traversal-like identifiers", () => {
    expect(() => createAssetObjectKey({
      environment: "production",
      ownerId: "../owner",
      projectId: "00000000-0000-4000-8000-000000000002",
      assetId: "00000000-0000-4000-8000-000000000003",
    })).toThrow();
  });
});

describe("asset lifecycle", () => {
  it("supports verify, ready and idempotent duplicate completion", () => {
    expect(transitionAssetStatus("PENDING_UPLOAD", "VERIFYING")).toEqual({ status: "VERIFYING", changed: true });
    expect(transitionAssetStatus("VERIFYING", "READY")).toEqual({ status: "READY", changed: true });
    expect(transitionAssetStatus("READY", "READY")).toEqual({ status: "READY", changed: false });
  });

  it("supports retry after temporary verification failure", () => {
    expect(transitionAssetStatus("VERIFYING", "PENDING_UPLOAD").status).toBe("PENDING_UPLOAD");
  });

  it("rejects invalid transitions and referenced deletion", () => {
    expect(() => transitionAssetStatus("PENDING_UPLOAD", "READY")).toThrow("Invalid asset transition");
    expect(() => transitionAssetStatus("READY", "DELETED", { hasReferences: true })).toThrow("Referenced");
  });

  it("detects only expired pending uploads", () => {
    const now = new Date("2026-10-14T00:00:00.000Z");
    expect(isUploadExpired("PENDING_UPLOAD", new Date("2026-10-13T23:59:59.000Z"), now)).toBe(true);
    expect(isUploadExpired("READY", new Date("2026-10-13T23:59:59.000Z"), now)).toBe(false);
  });
});
