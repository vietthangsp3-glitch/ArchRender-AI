import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssetApplicationError,
  StorageError,
  listAssetsSchema,
  prepareAssetUploadSchema,
} from "@archrender/assets";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  prepareUpload: vi.fn(),
  completeUpload: vi.fn(),
  createReadUrl: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  requestDeletion: vi.fn(),
  createThumbnailReadUrl: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.getRequestSession }));
vi.mock("@/lib/assets/server", () => ({
  getAssetService: () => ({
    prepareUpload: mocks.prepareUpload,
    completeUpload: mocks.completeUpload,
    createReadUrl: mocks.createReadUrl,
    list: mocks.list,
    get: mocks.get,
    requestDeletion: mocks.requestDeletion,
  }),
  getThumbnailService: () => ({ createReadUrl: mocks.createThumbnailReadUrl }),
}));

import { POST as initiate } from "./uploads/route";
import { POST as complete } from "./[assetId]/complete/route";
import { GET as readUrl } from "./[assetId]/read-url/route";
import { GET as thumbnail } from "./[assetId]/thumbnail/route";
import { DELETE as deleteAsset, GET as getAsset } from "./[assetId]/route";
import { GET as listAssets } from "./route";

const principal = { id: "00000000-0000-4000-8000-000000000001", role: "OWNER" };
const assetId = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ assetId }) };

function mutationRequest(path: string, body: unknown, origin = "http://localhost:3000") {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(origin = "http://localhost:3000") {
  return new Request(`http://localhost:3000/api/assets/${assetId}`, {
    method: "DELETE",
    headers: { host: "localhost:3000", origin },
  });
}

describe("asset upload APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue(principal);
  });

  it("rejects untrusted mutations before session and service work", async () => {
    const response = await initiate(mutationRequest("/api/assets/uploads", {}, "http://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(mocks.getRequestSession).not.toHaveBeenCalled();
    expect(mocks.prepareUpload).not.toHaveBeenCalled();
  });

  it("requires a validated session for initiate, complete and read URL", async () => {
    mocks.getRequestSession.mockResolvedValue(null);
    const responses = await Promise.all([
      initiate(mutationRequest("/api/assets/uploads", {})),
      complete(mutationRequest(`/api/assets/${assetId}/complete`, {}), context),
      readUrl(new Request(`http://localhost:3000/api/assets/${assetId}/read-url`), context),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
  });

  it("returns a bounded validation error without calling storage directly", async () => {
    mocks.prepareUpload.mockRejectedValue(prepareAssetUploadSchema.safeParse({}).error);
    const response = await initiate(mutationRequest("/api/assets/uploads", {}));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("passes only the authenticated principal and validated route identity to services", async () => {
    mocks.prepareUpload.mockResolvedValue({ assetId });
    mocks.completeUpload.mockResolvedValue({ assetId, status: "READY" });
    await initiate(mutationRequest("/api/assets/uploads", {
      requestId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      assetType: "SOURCE_IMAGE",
      originalName: "source.png",
      contentType: "image/png",
      byteSize: 100,
    }));
    await complete(mutationRequest(`/api/assets/${assetId}/complete`, {}), context);
    expect(mocks.prepareUpload).toHaveBeenCalledWith(principal, expect.not.objectContaining({ ownerId: expect.anything() }));
    expect(mocks.completeUpload).toHaveBeenCalledWith(
      principal,
      assetId,
      {},
      expect.objectContaining({ correlationId: expect.any(String), phase: "claim" }),
    );
  });

  it("returns a correlation ID and logs only structured completion failure fields", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.completeUpload.mockImplementation(async (_principal, _assetId, _body, trace) => {
      trace.phase = "final_put";
      throw new AssetApplicationError(
        "ASSET_STORAGE_UNAVAILABLE",
        "not logged",
        true,
        { cause: new StorageError("UNAVAILABLE", "createImmutableObject", true) },
      );
    });
    const requestId = crypto.randomUUID();
    const response = await complete(new Request(`http://localhost:3000/api/assets/${assetId}/complete`, {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: "{}",
    }), context);

    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(response.headers.get("x-archrender-finalization-phase")).toBe("final_put");
    expect(response.headers.get("x-archrender-storage-operation")).toBe("createImmutableObject");
    expect(response.headers.get("x-archrender-storage-code")).toBe("UNAVAILABLE");
    expect(response.headers.get("x-archrender-provider-status")).toBe("NONE");
    expect(response.headers.get("x-archrender-application-status")).toBe("503");
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      `"phase":"final_put","classification":"r2","operation":"createImmutableObject","storageCode":"UNAVAILABLE"`,
    ));
    expect(log.mock.calls.flat().join(" ")).not.toContain("not logged");
    log.mockRestore();
  });

  it("returns not-found for cross-owner asset access", async () => {
    mocks.createReadUrl.mockRejectedValue(new AssetApplicationError("ASSET_NOT_FOUND", "Not found."));
    const response = await readUrl(
      new Request(`http://localhost:3000/api/assets/${assetId}/read-url`),
      context,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ASSET_NOT_FOUND" });
  });

  it("authorizes and validates private thumbnail variants", async () => {
    mocks.createThumbnailReadUrl.mockResolvedValue({ assetId, variant: "grid", url: "https://signed.invalid/grid" });
    const response = await thumbnail(
      new Request(`http://localhost:3000/api/assets/${assetId}/thumbnail?variant=grid`),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-archrender-storage-contract")).toBe("2d-d-final-v1");
    expect(mocks.createThumbnailReadUrl).toHaveBeenCalledWith(principal, assetId, "grid");

    const invalid = await thumbnail(
      new Request(`http://localhost:3000/api/assets/${assetId}/thumbnail?variant=original`),
      context,
    );
    expect(invalid.status).toBe(400);
  });

  it("validates bounded list query parameters", async () => {
    mocks.list.mockRejectedValue(listAssetsSchema.safeParse({ pageSize: 1000 }).error);
    const response = await listAssets(
      new Request("http://localhost:3000/api/assets?pageSize=1000"),
    );
    expect(response.status).toBe(400);
    expect(mocks.list).toHaveBeenCalledWith(principal, expect.objectContaining({ pageSize: "1000" }));
  });

  it("keeps detail owner-scoped and returns no-store responses", async () => {
    mocks.get.mockRejectedValue(new AssetApplicationError("ASSET_NOT_FOUND", "Not found."));
    const response = await getAsset(
      new Request(`http://localhost:3000/api/assets/${assetId}`),
      context,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects untrusted deletion and referenced assets", async () => {
    const untrusted = await deleteAsset(deleteRequest("http://attacker.invalid"), context);
    expect(untrusted.status).toBe(403);
    expect(mocks.requestDeletion).not.toHaveBeenCalled();

    mocks.requestDeletion.mockRejectedValue(
      new AssetApplicationError("ASSET_REFERENCED", "Referenced."),
    );
    const referenced = await deleteAsset(deleteRequest(), context);
    expect(referenced.status).toBe(422);
    expect(mocks.requestDeletion).toHaveBeenCalledWith(principal, assetId);
  });
});
