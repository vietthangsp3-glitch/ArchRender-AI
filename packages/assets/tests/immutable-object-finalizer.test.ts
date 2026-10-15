import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { StorageError } from "../src/errors.js";
import { ImmutableObjectFinalizer } from "../src/immutable-object-finalizer.js";
import { createFinalObjectKey, createStagingObjectKey } from "../src/object-key.js";
import type {
  BoundedObjectContent,
  CreateImmutableObjectInput,
  CreatePresignedUploadInput,
  PresignedUploadRequest,
  ReadObjectOptions,
  StorageProvider,
  StoredObjectMetadata,
} from "../src/storage-provider.js";
import type { StorageObjectKey } from "../src/types.js";

type Stored = StoredObjectMetadata & { bytes: Uint8Array };

class CreateOnceStorage implements StorageProvider {
  readonly objects = new Map<string, Stored>();
  createAttempts = 0;
  successfulCreates = 0;

  async createPresignedUpload(_input: CreatePresignedUploadInput): Promise<PresignedUploadRequest> {
    throw new Error("not used");
  }

  async createPresignedReadUrl(): Promise<string> {
    throw new Error("not used");
  }

  async createImmutableObject(input: CreateImmutableObjectInput): Promise<StoredObjectMetadata> {
    this.createAttempts += 1;
    if (this.objects.has(input.key)) {
      throw new StorageError("PRECONDITION_FAILED", "createImmutableObject", false);
    }
    const etag = createHash("md5").update(input.bytes).digest("hex");
    const object: Stored = {
      bytes: new Uint8Array(input.bytes),
      contentLength: input.bytes.byteLength,
      contentType: input.contentType,
      etag: `"${etag}"`,
      metadata: { ...input.metadata },
    };
    this.objects.set(input.key, object);
    this.successfulCreates += 1;
    return object;
  }

  async headObject(key: StorageObjectKey): Promise<StoredObjectMetadata> {
    const object = this.objects.get(key);
    if (!object) throw new StorageError("NOT_FOUND", "headObject", false);
    return object;
  }

  async readObject(
    key: StorageObjectKey,
    maxBytes: number,
    options: ReadObjectOptions = {},
  ): Promise<BoundedObjectContent> {
    const object = this.objects.get(key);
    if (!object) throw new StorageError("NOT_FOUND", "readObject", false);
    if (options.ifMatch && options.ifMatch !== object.etag) {
      throw new StorageError("PRECONDITION_FAILED", "readObject", false);
    }
    if (object.bytes.byteLength > maxBytes) {
      throw new StorageError("INVALID_RESPONSE", "readObject", false);
    }
    return { ...object, bytes: new Uint8Array(object.bytes) };
  }

  async deleteObject(key: StorageObjectKey): Promise<void> {
    this.objects.delete(key);
  }

  async objectExists(key: StorageObjectKey): Promise<boolean> {
    return this.objects.has(key);
  }
}

const keyInput = {
  environment: "development" as const,
  ownerId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  assetId: "00000000-0000-4000-8000-000000000003",
};

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("immutable object finalization contract", () => {
  it("separates browser-writable staging and server-controlled final keys", () => {
    const staging = createStagingObjectKey({ ...keyInput, randomId: "a".repeat(32) });
    const final = createFinalObjectKey({ ...keyInput, randomId: "b".repeat(32) });
    expect(staging).toContain("/staging/");
    expect(final).toContain("/original/");
    expect(staging).not.toBe(final);
  });

  it("recovers idempotently when final storage succeeded before the database commit", async () => {
    const storage = new CreateOnceStorage();
    const finalizer = new ImmutableObjectFinalizer(storage, 1024);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const input = {
      assetId: keyInput.assetId,
      finalKey: createFinalObjectKey(keyInput),
      bytes,
      contentType: "image/png",
      checksumSha256: checksum(bytes),
    };
    const first = await finalizer.finalize(input);
    const recovered = await finalizer.finalize(input);
    expect(recovered).toEqual(first);
    expect(storage.createAttempts).toBe(2);
    expect(storage.successfulCreates).toBe(1);
  });

  it("reports only final PUT and read-back phases around storage operations", async () => {
    const storage = new CreateOnceStorage();
    const phases: string[] = [];
    const bytes = new Uint8Array([4, 5, 6]);
    await new ImmutableObjectFinalizer(storage, 1024).finalize({
      assetId: keyInput.assetId,
      finalKey: createFinalObjectKey(keyInput),
      bytes,
      contentType: "image/png",
      checksumSha256: checksum(bytes),
    }, (phase) => phases.push(phase));
    expect(phases).toEqual(["final_put", "final_readback"]);

    storage.createImmutableObject = async () => {
      throw new StorageError("ACCESS_DENIED", "createImmutableObject", false);
    };
    phases.length = 0;
    await expect(new ImmutableObjectFinalizer(storage, 1024).finalize({
      assetId: keyInput.assetId,
      finalKey: createFinalObjectKey({ ...keyInput, randomId: "f".repeat(32) }),
      bytes,
      contentType: "image/png",
      checksumSha256: checksum(bytes),
    }, (phase) => phases.push(phase))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(phases).toEqual(["final_put"]);
  });

  it("allows only one conflicting concurrent final identity", async () => {
    const storage = new CreateOnceStorage();
    const finalizer = new ImmutableObjectFinalizer(storage, 1024);
    const finalKey = createFinalObjectKey(keyInput);
    const first = new Uint8Array([1, 1, 1]);
    const second = new Uint8Array([2, 2, 2]);
    const results = await Promise.allSettled([
      finalizer.finalize({ assetId: keyInput.assetId, finalKey, bytes: first, contentType: "image/png", checksumSha256: checksum(first) }),
      finalizer.finalize({ assetId: keyInput.assetId, finalKey, bytes: second, contentType: "image/png", checksumSha256: checksum(second) }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(storage.successfulCreates).toBe(1);
  });

  it("keeps the final checksum invariant after an old staging upload is replayed", async () => {
    const storage = new CreateOnceStorage();
    const stagingKey = createStagingObjectKey(keyInput);
    const finalKey = createFinalObjectKey(keyInput);
    const verified = new Uint8Array([7, 8, 9]);
    storage.objects.set(stagingKey, {
      bytes: verified,
      contentLength: verified.byteLength,
      contentType: "image/png",
      etag: '"staging-v1"',
      metadata: { assetid: keyInput.assetId },
    });
    const snapshot = await storage.readObject(stagingKey, 1024, { ifMatch: '"staging-v1"' });
    await new ImmutableObjectFinalizer(storage, 1024).finalize({
      assetId: keyInput.assetId,
      finalKey,
      bytes: snapshot.bytes,
      contentType: "image/png",
      checksumSha256: checksum(snapshot.bytes),
    });
    const replay = new Uint8Array([0, 0, 0]);
    storage.objects.set(stagingKey, {
      bytes: replay,
      contentLength: replay.byteLength,
      contentType: "image/png",
      etag: '"staging-v2"',
      metadata: { assetid: keyInput.assetId },
    });
    expect(checksum(storage.objects.get(finalKey)!.bytes)).toBe(checksum(verified));
  });

  it("fails closed on caller checksum mismatch and memory bound violations", async () => {
    const storage = new CreateOnceStorage();
    const finalKey = createFinalObjectKey(keyInput);
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(new ImmutableObjectFinalizer(storage, 1024).finalize({
      assetId: keyInput.assetId,
      finalKey,
      bytes,
      contentType: "image/png",
      checksumSha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "ASSET_INTEGRITY_CONFLICT" });
    await expect(new ImmutableObjectFinalizer(storage, 2).finalize({
      assetId: keyInput.assetId,
      finalKey,
      bytes,
      contentType: "image/png",
      checksumSha256: checksum(bytes),
    })).rejects.toMatchObject({ code: "ASSET_INTEGRITY_CONFLICT" });
    expect(storage.successfulCreates).toBe(0);
  });
});
