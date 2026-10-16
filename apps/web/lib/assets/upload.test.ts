import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initiate: vi.fn(),
  upload: vi.fn(),
  complete: vi.fn(),
  get: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    initiateAssetUpload: mocks.initiate,
    completeAssetUpload: mocks.complete,
    getAsset: mocks.get,
  };
});
vi.mock("./direct-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./direct-upload")>();
  return { ...actual, uploadDirectlyToStorage: mocks.upload };
});

import { AssetClientError } from "./client";
import { DirectUploadError } from "./direct-upload";
import { uploadAndVerifyAsset } from "./upload";

const policy = {
  maxUploadBytes: 1024,
  acceptedContentTypes: ["image/png"],
  uploadAssetTypes: ["SOURCE_IMAGE"] as const,
};
const projectId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const readyAsset = {
  id: assetId,
  project: { id: projectId, name: "Synthetic", status: "ACTIVE" as const },
  assetType: "SOURCE_IMAGE" as const,
  status: "READY" as const,
  originalName: "fixture.png",
  contentType: "image/png",
  byteSize: 3,
  width: 1,
  height: 1,
  uploadExpired: false,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  verifiedAt: "2026-10-16T00:00:00.000Z",
};

function fixtureFile() {
  const file = new File(["png"], "fixture.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("png").buffer,
  });
  return file;
}

afterEach(() => vi.clearAllMocks());

describe("secure local asset upload orchestration", () => {
  it("uses initiate, direct PUT, complete, and READY read-back in order", async () => {
    mocks.initiate.mockResolvedValue({
      assetId,
      status: "PENDING_UPLOAD",
      upload: { method: "PUT", url: "https://signed.invalid/redacted", expiresAt: "2026-10-16T01:00:00.000Z", requiredHeaders: { "content-type": "image/png" } },
    });
    mocks.upload.mockResolvedValue({ etag: "fixture-etag" });
    mocks.complete.mockResolvedValue({ assetId, status: "READY" });
    mocks.get.mockResolvedValue(readyAsset);
    const phases: string[] = [];

    const asset = await uploadAndVerifyAsset({
      requestId: "request_0000000000001",
      projectId,
      assetType: "SOURCE_IMAGE",
      file: fixtureFile(),
      policy,
      onPhase: (phase) => phases.push(phase),
    });

    expect(asset).toEqual(readyAsset);
    expect(phases).toEqual(["initiating", "uploading", "verifying", "success"]);
    expect(mocks.initiate).toHaveBeenCalledWith(expect.objectContaining({ projectId, assetType: "SOURCE_IMAGE" }), undefined);
    expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ file: expect.any(File), requiredHeaders: { "content-type": "image/png" } }));
    expect(mocks.complete).toHaveBeenCalledWith(assetId, expect.objectContaining({ etag: "fixture-etag", checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }), undefined);
    expect(mocks.get).toHaveBeenCalledWith(assetId, undefined);
  });

  it("fails closed when READY read-back does not belong to the requested project", async () => {
    mocks.initiate.mockResolvedValue({ assetId, upload: { url: "https://signed.invalid/redacted", requiredHeaders: {} } });
    mocks.upload.mockResolvedValue({});
    mocks.complete.mockResolvedValue({ assetId, status: "READY" });
    mocks.get.mockResolvedValue({ ...readyAsset, project: { ...readyAsset.project, id: "33333333-3333-4333-8333-333333333333" } });

    await expect(uploadAndVerifyAsset({
      requestId: "request_0000000000002",
      projectId,
      assetType: "SOURCE_IMAGE",
      file: fixtureFile(),
      policy,
    })).rejects.toEqual(expect.objectContaining<Partial<AssetClientError>>({ code: "ASSET_INTEGRITY_CONFLICT" }));
  });

  it.each([
    ["initiate", () => mocks.initiate.mockRejectedValue(new AssetClientError("ASSET_INVALID_ORIGIN", 403)), "ASSET_INVALID_ORIGIN", 403],
    ["put", () => {
      mocks.initiate.mockResolvedValue({ assetId, upload: { url: "https://signed.invalid/redacted", requiredHeaders: {} } });
      mocks.upload.mockRejectedValue(new DirectUploadError("DIRECT_UPLOAD_NETWORK_ERROR"));
    }, "DIRECT_UPLOAD_NETWORK_ERROR", undefined],
    ["put", () => {
      mocks.initiate.mockResolvedValue({ assetId, upload: { url: "https://signed.invalid/redacted", requiredHeaders: {} } });
      mocks.upload.mockRejectedValue(new DirectUploadError("DIRECT_UPLOAD_HTTP_ERROR", 403, "R2_SIGNATURE_MISMATCH"));
    }, "R2_SIGNATURE_MISMATCH", 403],
    ["complete", () => {
      mocks.initiate.mockResolvedValue({ assetId, upload: { url: "https://signed.invalid/redacted", requiredHeaders: {} } });
      mocks.upload.mockResolvedValue({});
      mocks.complete.mockRejectedValue(new AssetClientError("ASSET_STORAGE_UNAVAILABLE", 503, true));
    }, "ASSET_STORAGE_UNAVAILABLE", 503],
  ] as const)("reports a sanitized %s stage failure", async (stage, arrange, code, httpStatus) => {
    arrange();
    await expect(uploadAndVerifyAsset({
      requestId: "request_0000000000003",
      projectId,
      assetType: "SOURCE_IMAGE",
      file: fixtureFile(),
      policy,
    })).rejects.toMatchObject({ stage, code, ...(httpStatus ? { httpStatus } : {}) });
  });
});
