import { afterEach, describe, expect, it, vi } from "vitest";

import { browserUploadHeaders, classifyR2ErrorResponse, uploadDirectlyToStorage } from "./direct-upload";

class FakeXhr {
  static latest: FakeXhr;
  status = 200;
  responseText = "";
  timeout = 0;
  uploadListeners = new Map<string, (event: ProgressEvent) => void>();
  listeners = new Map<string, () => void>();
  upload = { addEventListener: (name: string, listener: (event: ProgressEvent) => void) => this.uploadListeners.set(name, listener) };
  constructor() { FakeXhr.latest = this; }
  open() {}
  setRequestHeader() {}
  getResponseHeader(name: string) { return name === "ETag" ? "etag" : null; }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  send() {}
  abort() { this.listeners.get("abort")?.(); }
}

afterEach(() => vi.unstubAllGlobals());

describe("direct browser upload contract", () => {
  it("never attempts to set the forbidden Content-Length header", () => {
    expect(browserUploadHeaders({
      "content-type": "image/png",
      "content-length": "123",
      "x-amz-meta-assetid": "asset-id",
    })).toEqual({
      "content-type": "image/png",
      "x-amz-meta-assetid": "asset-id",
    });
  });

  it("reports progress and supports cancellation", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress = vi.fn();
    const controller = new AbortController();
    const pending = uploadDirectlyToStorage({
      url: "https://signed.invalid/redacted",
      file: new Blob(["1234"]),
      requiredHeaders: { "content-type": "image/png" },
      signal: controller.signal,
      onProgress: progress,
    });
    FakeXhr.latest.uploadListeners.get("progress")?.({ loaded: 2, total: 4, lengthComputable: true } as ProgressEvent);
    expect(progress).toHaveBeenCalledWith(2, 4);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    ["error", "DIRECT_UPLOAD_NETWORK_ERROR", undefined],
    ["timeout", "DIRECT_UPLOAD_TIMEOUT", undefined],
    ["load", "DIRECT_UPLOAD_HTTP_ERROR", 403],
  ] as const)("classifies %s without exposing the signed URL", async (event, code, httpStatus) => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const pending = uploadDirectlyToStorage({
      url: "https://signed.invalid/private?credential=redacted",
      file: new Blob(["1234"]),
      requiredHeaders: { "content-type": "image/png" },
    });
    if (event === "load") FakeXhr.latest.status = 403;
    FakeXhr.latest.listeners.get(event)?.();
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "DirectUploadError", code, ...(httpStatus ? { httpStatus } : {}) });
    expect(String((error as Error).message)).not.toContain("signed.invalid");
  });

  it.each([
    ["SignatureDoesNotMatch", "R2_SIGNATURE_MISMATCH"],
    ["AccessDenied", "R2_ACCESS_DENIED"],
    ["InvalidAccessKeyId", "R2_INVALID_ACCESS_KEY"],
    ["InvalidToken", "R2_INVALID_TOKEN"],
    ["ExpiredToken", "R2_INVALID_TOKEN"],
    ["NoSuchBucket", "R2_BUCKET_NOT_FOUND"],
    ["RequestExpired", "R2_REQUEST_EXPIRED"],
    ["UnexpectedProviderCode", "R2_OTHER_ERROR"],
  ] as const)("redacts R2 provider code %s to %s", (providerCode, expected) => {
    expect(classifyR2ErrorResponse(`<Error><Code>${providerCode}</Code><Message>sensitive</Message></Error>`))
      .toBe(expected);
  });

  it("captures only the safe R2 classification from an HTTP error body", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const pending = uploadDirectlyToStorage({
      url: "https://signed.invalid/private?signature=must-not-leak",
      file: new Blob(["1234"]),
      requiredHeaders: { "content-type": "image/png" },
    });
    FakeXhr.latest.status = 403;
    FakeXhr.latest.responseText = "<Error><Code>SignatureDoesNotMatch</Code><Message>private detail</Message></Error>";
    FakeXhr.latest.listeners.get("load")?.();

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "DIRECT_UPLOAD_HTTP_ERROR",
      httpStatus: 403,
      providerCode: "R2_SIGNATURE_MISMATCH",
    });
    expect(JSON.stringify(error)).not.toContain("private detail");
    expect(String((error as Error).message)).not.toContain("signature=");
  });
});
