import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeClaim } from "@archrender/ai-engine";

import { VerifiedInputMaterializer } from "../src/input-materializer";

const ownerId = "9e24af5b-8f6e-4a1e-b4e9-852692e825d6";
const assetId = "5d93ec65-2de8-451c-bbf8-b37854af763c";
const objectId = "83f31e87-18d4-4ac1-980e-8cb4416a2d30";
const bytes = Uint8Array.from([1, 2, 3]);
const checksum = createHash("sha256").update(bytes).digest("hex");
const claim = {
  jobId: "e1cdf8dd-9f8f-4f62-9ed4-55757e83980d", ownerId, projectId: "af248ce0-19be-4ec5-9a14-87c72527e607",
  generation: 1, leaseToken: "x".repeat(32), type: "IMAGE_RENDER", parameters: {}, workflow: { modelId: "model" },
  inputSnapshot: [{ assetId, role: "SOURCE_IMAGE", position: 0, storageObjectId: objectId, checksumSha256: checksum, storageEtag: "etag", contentType: "image/png" }],
} satisfies RuntimeClaim;

describe("verified input materializer", () => {
  it("binds the owner-scoped immutable identity and cleans the exact staged input", async () => {
    const findUnique = vi.fn(async () => ({
      id: objectId, assetId, ownerId, role: "ORIGINAL", state: "VERIFIED", checksumSha256: checksum,
      storageEtag: "etag", contentType: "image/png", deletedAt: null, byteSize: 3n, objectKey: "private-key",
    }));
    const readObject = vi.fn(async () => ({ bytes, contentLength: 3, contentType: "image/png", etag: "etag", metadata: {} }));
    const stageInput = vi.fn(async (_workspace: string, filename: string) => `remote_${filename}`);
    const deleteInput = vi.fn(async () => undefined);
    const materializer = new VerifiedInputMaterializer(
      { assetStorageObject: { findUnique } } as never,
      { readObject } as never,
      { stageInput, deleteInput } as never,
      1024,
    );
    await expect(materializer.materialize(claim)).resolves.toEqual({ source: "remote_source.png" });
    expect(findUnique).toHaveBeenCalledWith({ where: { id_assetId_ownerId: { id: objectId, assetId, ownerId } } });
    expect(readObject).toHaveBeenCalledWith("private-key", 1024, { ifMatch: "etag" });
    await materializer.cleanup(claim);
    expect(deleteInput).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), "source.png", checksum);
  });

  it("fails closed before staging when database identity differs", async () => {
    const stageInput = vi.fn();
    const materializer = new VerifiedInputMaterializer(
      { assetStorageObject: { findUnique: async () => ({ role: "ORIGINAL", state: "VERIFIED", checksumSha256: "0".repeat(64) }) } } as never,
      { readObject: vi.fn() } as never,
      { stageInput, deleteInput: vi.fn() } as never,
      1024,
    );
    await expect(materializer.materialize(claim)).rejects.toThrow("INPUT_IMMUTABLE_IDENTITY_MISMATCH");
    expect(stageInput).not.toHaveBeenCalled();
  });
});
