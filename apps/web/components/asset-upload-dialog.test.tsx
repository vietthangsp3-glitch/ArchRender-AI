import { describe, expect, it } from "vitest";

import { validateUploadFile } from "@/lib/assets/upload";

const policy = {
  maxUploadBytes: 25 * 1024 * 1024,
  acceptedContentTypes: ["image/jpeg", "image/png", "image/webp"],
  uploadAssetTypes: ["SOURCE_IMAGE"] as const,
};

describe("asset upload validation", () => {
  it("accepts supported images within the backend policy", () => {
    expect(validateUploadFile(new File(["png"], "source.png", { type: "image/png" }), policy)).toBeNull();
  });

  it("rejects unsupported MIME and oversized files before initiate", () => {
    expect(validateUploadFile(new File(["gif"], "source.gif", { type: "image/gif" }), policy)).toMatch(/JPG/);
    const oversized = new File([new Uint8Array(policy.maxUploadBytes + 1)], "large.png", { type: "image/png" });
    expect(validateUploadFile(oversized, policy)).toMatch(/25 MB/);
  });
});
