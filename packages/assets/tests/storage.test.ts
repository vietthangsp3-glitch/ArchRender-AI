import { Readable } from "node:stream";

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { loadAssetStorageConfig } from "../src/config.js";
import {
  AssetApplicationError,
  createSafeCompletionDiagnostic,
  mapStorageError,
  redactSensitiveData,
  StorageError,
} from "../src/errors.js";
import {
  createR2StorageProvider,
  createR2S3ClientConfig,
  R2StorageProvider,
  type S3ClientPort,
} from "../src/r2-storage-provider.js";
import type { StorageObjectKey } from "../src/types.js";

const key = "development/owners/o/projects/p/assets/a/r" as StorageObjectKey;

describe("R2 storage adapter", () => {
  it("presigns a constrained PUT with a short TTL", async () => {
    const send = vi.fn();
    const presign = vi.fn().mockResolvedValue("https://signed.invalid/upload?redacted=yes");
    const provider = new R2StorageProvider(
      { send } as S3ClientPort,
      "private-assets",
      presign,
      () => new Date("2026-10-14T00:00:00.000Z"),
    );
    const result = await provider.createPresignedUpload({
      key,
      contentType: "image/png",
      contentLength: 123,
      expiresInSeconds: 300,
      metadata: { assetId: "asset-id" },
    });
    expect(result).toMatchObject({ method: "PUT", expiresAt: new Date("2026-10-14T00:05:00.000Z") });
    const command = presign.mock.calls[0]?.[1];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: "private-assets",
      Key: key,
      ContentType: "image/png",
      ContentLength: 123,
    });
  });

  it("keeps upload metadata in the signed headers instead of hoisting it", async () => {
    const provider = createR2StorageProvider(loadAssetStorageConfig({
      R2_ACCOUNT_ID: "account-id",
      R2_BUCKET_NAME: "private-assets",
      R2_ACCESS_KEY_ID: "not-a-real-key",
      R2_SECRET_ACCESS_KEY: "not-a-real-secret",
    }));
    const result = await provider.createPresignedUpload({
      key,
      contentType: "image/png",
      contentLength: 123,
      expiresInSeconds: 300,
      metadata: { assetId: "asset-id" },
    });
    const url = new URL(result.url);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    expect(url.searchParams.has("x-amz-meta-assetid")).toBe(false);
    expect(signedHeaders).toEqual(expect.arrayContaining([
      "content-length",
      "content-type",
      "x-amz-meta-assetid",
    ]));
  });

  it.each([29, 901, 3.5])("rejects unsafe signed URL TTL %s", async (ttl) => {
    const provider = new R2StorageProvider({ send: vi.fn() } as S3ClientPort, "bucket", vi.fn());
    await expect(provider.createPresignedReadUrl(key, ttl)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("uses a bounded range and rejects a provider that returns too much data", async () => {
    const send = vi.fn().mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(11) },
      ContentLength: 11,
    });
    const provider = new R2StorageProvider({ send } as S3ClientPort, "bucket", vi.fn());
    await expect(provider.readObject(key, 10, { ifMatch: "expected-etag" }))
      .rejects.toBeInstanceOf(StorageError);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input.Range).toBe("bytes=0-10");
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input.IfMatch).toBe("expected-etag");
  });

  it("creates a server-controlled final object with atomic create-once semantics", async () => {
    const send = vi.fn().mockResolvedValue({ ETag: '"final-etag"' });
    const provider = new R2StorageProvider({ send } as S3ClientPort, "bucket", vi.fn());
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(provider.createImmutableObject({
      key,
      bytes,
      contentType: "image/png",
      metadata: { assetId: "asset", role: "original", sha256: "a".repeat(64) },
    })).resolves.toMatchObject({ contentLength: 3, etag: '"final-etag"' });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: "bucket",
      Key: key,
      IfNoneMatch: "*",
      ContentLength: 3,
      ContentType: "image/png",
      Metadata: { assetId: "asset", role: "original", sha256: "a".repeat(64) },
    });
    expect((command as PutObjectCommand).input.ContentMD5).toBe("Uonfc331cyb83SJZevsfrA==");
  });

  it("serializes an R2-compatible immutable PUT without optional AWS CRC32 headers", async () => {
    let serializedHeaders: Record<string, string> = {};
    const requestHandler = {
      handle: vi.fn(async (request: { headers: Record<string, string> }) => {
        serializedHeaders = { ...request.headers };
        return {
          response: {
            statusCode: 200,
            headers: { etag: '"final-etag"' },
            body: Readable.from([]),
          },
        };
      }),
      updateHttpClientConfig: vi.fn(),
      httpHandlerConfigs: vi.fn(() => ({})),
    };
    const config = loadAssetStorageConfig({
      R2_ACCOUNT_ID: "account-id",
      R2_BUCKET_NAME: "private-assets",
      R2_ACCESS_KEY_ID: "not-a-real-key",
      R2_SECRET_ACCESS_KEY: "not-a-real-secret",
    });
    const client = new S3Client({
      ...createR2S3ClientConfig(config),
      requestHandler: requestHandler as never,
    });
    const provider = new R2StorageProvider(client, config.bucket, vi.fn());

    await provider.createImmutableObject({
      key,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      metadata: { assetId: "asset", role: "original", sha256: "a".repeat(64) },
    });

    expect(serializedHeaders["if-none-match"]).toBe("*");
    expect(serializedHeaders["content-md5"]).toBe("Uonfc331cyb83SJZevsfrA==");
    expect(serializedHeaders["x-amz-sdk-checksum-algorithm"]).toBeUndefined();
    expect(serializedHeaders["x-amz-checksum-crc32"]).toBeUndefined();
  });

  it("maps not-found existence checks without leaking provider errors", async () => {
    const send = vi.fn().mockRejectedValue({ name: "NoSuchKey", message: "secret detail" });
    const provider = new R2StorageProvider({ send } as S3ClientPort, "bucket", vi.fn());
    await expect(provider.objectExists(key)).resolves.toBe(false);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });
});

describe("storage configuration and safe errors", () => {
  const environment = {
    R2_ACCOUNT_ID: "account-id",
    R2_BUCKET_NAME: "private-assets",
    R2_ACCESS_KEY_ID: "not-a-real-key",
    R2_SECRET_ACCESS_KEY: "not-a-real-secret",
  } as NodeJS.ProcessEnv;

  it("uses bounded defaults without needing live credentials", () => {
    const config = loadAssetStorageConfig(environment);
    expect(config.signedUrlTtlSeconds).toBe(300);
    expect(config.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(config.endpoint).toContain("r2.cloudflarestorage.com");
  });

  it("rejects out-of-policy TTL configuration", () => {
    expect(() => loadAssetStorageConfig({ ...environment, ASSET_SIGNED_URL_TTL_SECONDS: "901" })).toThrow();
  });

  it("rejects an endpoint outside the configured R2 account", () => {
    expect(() => loadAssetStorageConfig({
      ...environment,
      R2_ENDPOINT: "https://example.invalid",
    })).toThrow("match the configured account");
  });

  it("maps provider errors to stable codes", () => {
    expect(mapStorageError({ $metadata: { httpStatusCode: 429 } }, "head")).toMatchObject({
      code: "THROTTLED",
      retryable: true,
      message: "Storage operation failed (THROTTLED).",
    });
  });

  it("maps atomic create conflicts without leaking provider details", () => {
    expect(mapStorageError({ name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }, "put"))
      .toMatchObject({ code: "PRECONDITION_FAILED", retryable: false });
  });

  it("normalizes provider failures with an exact safe operation and classification", () => {
    const storage = mapStorageError(
      { name: "InvalidRequest", $metadata: { httpStatusCode: 400 }, message: "sensitive provider detail" },
      "createImmutableObject",
    );
    const error = new AssetApplicationError(
      "ASSET_STORAGE_UNAVAILABLE",
      "Storage unavailable.",
      true,
      { cause: storage },
    );
    expect(createSafeCompletionDiagnostic(
      { correlationId: "00000000-0000-4000-8000-000000000001", phase: "final_put" },
      error,
      503,
    )).toEqual({
      correlationId: "00000000-0000-4000-8000-000000000001",
      phase: "final_put",
      classification: "r2",
      operation: "createImmutableObject",
      storageCode: "UNAVAILABLE",
      providerHttpStatus: 400,
      applicationCode: "ASSET_STORAGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("redacts credentials, signed URLs, cookies and tokens recursively", () => {
    expect(redactSensitiveData({
      code: "SAFE",
      credentials: { accessKeyId: "hidden" },
      nested: { signedUrl: "hidden", cookie: "hidden", token: "hidden" },
    })).toEqual({
      code: "SAFE",
      credentials: "[REDACTED]",
      nested: { signedUrl: "[REDACTED]", cookie: "[REDACTED]", token: "[REDACTED]" },
    });
  });
});
