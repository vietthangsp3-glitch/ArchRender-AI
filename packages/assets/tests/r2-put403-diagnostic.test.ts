import { describe, expect, it } from "vitest";

import {
  assertSerializedUploadContract,
  classifyR2DiagnosticBody,
} from "../scripts/r2-put403-diagnostic-support.js";

describe("R2 PUT 403 diagnostic support", () => {
  it.each([
    ["SignatureDoesNotMatch", "SIGNATURE_MISMATCH"],
    ["AccessDenied", "ACCESS_DENIED"],
    ["InvalidAccessKeyId", "INVALID_ACCESS_KEY"],
    ["InvalidToken", "INVALID_TOKEN"],
    ["NoSuchBucket", "BUCKET_NOT_FOUND"],
    ["RequestTimeTooSkewed", "REQUEST_EXPIRED"],
    ["SomethingElse", "OTHER_R2_ERROR"],
  ] as const)("maps %s to the redacted code %s", (providerCode, expected) => {
    expect(classifyR2DiagnosticBody(`<Error><Code>${providerCode}</Code><Message>private</Message></Error>`))
      .toBe(expected);
  });

  it("requires exact byte length, content type, metadata and signed headers", () => {
    const base = {
      url: "https://account.r2.cloudflarestorage.com/renderai/key?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-meta-assetid",
      requiredHeaders: {
        "content-length": "243346",
        "content-type": "image/jpeg",
        "x-amz-meta-assetid": "synthetic-asset",
      },
      contentType: "image/jpeg",
      contentLength: 243_346,
      assetId: "synthetic-asset",
    };
    expect(() => assertSerializedUploadContract(base)).not.toThrow();
    expect(() => assertSerializedUploadContract({ ...base, contentLength: 243_345 }))
      .toThrow("SIGNED_UPLOAD_CONTRACT_MISMATCH");
  });
});
