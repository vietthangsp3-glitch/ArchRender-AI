// @vitest-environment node

import {
  createR2StorageProvider,
  loadAssetStorageConfig,
  type StorageObjectKey,
} from "@archrender/assets";
import { describe, expect, it } from "vitest";

import { browserUploadHeaders } from "./direct-upload";

describe("browser and R2 presigner compatibility", () => {
  it("serializes every SigV4 signed header with the exact declared values", async () => {
    const provider = createR2StorageProvider(loadAssetStorageConfig({
      NODE_ENV: "test",
      R2_ACCOUNT_ID: "account-id",
      R2_BUCKET_NAME: "renderai",
      R2_ACCESS_KEY_ID: "not-a-real-key",
      R2_SECRET_ACCESS_KEY: "not-a-real-secret",
    }));
    const contentLength = 123;
    const contract = await provider.createPresignedUpload({
      key: "staging/serialized-browser-contract" as StorageObjectKey,
      contentType: "image/png",
      contentLength,
      expiresInSeconds: 300,
      metadata: { assetId: "synthetic-asset-id" },
    });
    const url = new URL(contract.url);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    const scriptHeaders = browserUploadHeaders(contract.requiredHeaders);
    const serializedBrowserHeaders: Record<string, string> = {
      host: url.host,
      ...scriptHeaders,
      // Content-Length is a forbidden script header. A browser serializes it
      // from the Blob body, so it still has to match the signed byte length.
      "content-length": String(contentLength),
    };

    expect(contract.method).toBe("PUT");
    expect(scriptHeaders).toEqual({
      "content-type": "image/png",
      "x-amz-meta-assetid": "synthetic-asset-id",
    });
    expect(contract.requiredHeaders["content-length"]).toBe(String(contentLength));
    expect(signedHeaders).toEqual([
      "content-length",
      "content-type",
      "host",
      "x-amz-meta-assetid",
    ]);
    expect(signedHeaders.every((header) => serializedBrowserHeaders[header] !== undefined)).toBe(true);
    expect(url.searchParams.has("x-amz-meta-assetid")).toBe(false);
  });
});
