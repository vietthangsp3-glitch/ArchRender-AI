import { describe, expect, it, vi } from "vitest";

import { AssetRepository } from "../src/repositories/asset-repository.js";
import { ProjectRepository } from "../src/repositories/project-repository.js";
import { RenderJobRepository } from "../src/repositories/render-job-repository.js";
import type { DatabaseClient } from "../src/types.js";

describe("owner-scoped repositories", () => {
  it("uses the composite owner key when loading a project", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const database = {
      project: { findUnique },
    } as unknown as DatabaseClient;

    await new ProjectRepository(database).findById("owner-a", "project-1");

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        id_ownerId: { id: "project-1", ownerId: "owner-a" },
      },
      include: {
        _count: { select: { assets: true, renderJobs: true } },
      },
    });
  });

  it("scopes idempotency lookups to the owner", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const database = {
      renderJob: { findUnique },
    } as unknown as DatabaseClient;

    await new RenderJobRepository(database).findByIdempotencyKey(
      "owner-b",
      "request-123",
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        ownerId_idempotencyKey: {
          ownerId: "owner-b",
          idempotencyKey: "request-123",
        },
      },
    });
  });

  it("scopes asset upload idempotency to the owner", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const database = { asset: { findUnique } } as unknown as DatabaseClient;

    await new AssetRepository(database).findByUploadRequestId("owner-a", "upload-request");

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        ownerId_uploadRequestId: {
          ownerId: "owner-a",
          uploadRequestId: "upload-request",
        },
      },
    });
  });

  it("claims lifecycle transitions with owner and current-status conditions", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = { asset: { updateMany } } as unknown as DatabaseClient;

    await new AssetRepository(database).transition({
      ownerId: "owner-a",
      id: "asset-a",
      from: "PENDING_UPLOAD",
      to: "VERIFYING",
      verificationStartedAt: new Date("2026-10-14T00:00:00.000Z"),
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "asset-a",
        ownerId: "owner-a",
        status: "PENDING_UPLOAD",
        deletedAt: null,
      },
      data: expect.objectContaining({
        status: "VERIFYING",
        verificationAttempts: { increment: 1 },
      }),
    });
  });
});

describe("AssetRepository create state contract", () => {
  const baseInput = {
    ownerId: "owner-a",
    type: "SOURCE_IMAGE" as const,
    bucket: "integration-private-assets",
    objectKey: "development/owners/owner-a/assets/asset-a/original/object",
  };

  it("writes explicit fail-closed defaults for a new pending asset", async () => {
    const create = vi.fn().mockResolvedValue({ id: "asset-a" });
    const database = { asset: { create } } as unknown as DatabaseClient;

    await new AssetRepository(database).create(baseInput);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "PENDING_UPLOAD",
        storageLayout: "LEGACY_SINGLE_OBJECT",
        integrityStatus: "PENDING",
      }),
    });
  });

  it("accepts staged pending uploads and explicit legacy READY imports", async () => {
    const create = vi.fn().mockResolvedValue({ id: "asset-a" });
    const database = { asset: { create } } as unknown as DatabaseClient;
    const repository = new AssetRepository(database);

    await repository.create({
      ...baseInput,
      storageLayout: "STAGED_IMMUTABLE_V1",
      integrityStatus: "PENDING",
    });
    await repository.create({
      ...baseInput,
      status: "READY",
      storageLayout: "LEGACY_SINGLE_OBJECT",
      integrityStatus: "LEGACY_GUARDED",
    });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      status: "READY" as const,
      storageLayout: "LEGACY_SINGLE_OBJECT" as const,
      integrityStatus: "PENDING" as const,
    },
    {
      status: "READY" as const,
      storageLayout: "STAGED_IMMUTABLE_V1" as const,
      integrityStatus: "LEGACY_GUARDED" as const,
    },
    {
      status: "READY" as const,
      storageLayout: "STAGED_IMMUTABLE_V1" as const,
      integrityStatus: "VERIFIED_IMMUTABLE" as const,
    },
    {
      status: "PENDING_UPLOAD" as const,
      storageLayout: "LEGACY_SINGLE_OBJECT" as const,
      integrityStatus: "FAILED" as const,
    },
  ])("rejects an invalid create state before querying PostgreSQL: %o", (state) => {
    const create = vi.fn();
    const database = { asset: { create } } as unknown as DatabaseClient;

    expect(() => new AssetRepository(database).create({ ...baseInput, ...state })).toThrow(
      /immutable storage|finalizeImmutable/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
