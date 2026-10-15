import { afterEach, describe, expect, it, vi } from "vitest";

import { browserUploadHeaders, uploadDirectlyToStorage } from "./direct-upload";

class FakeXhr {
  static latest: FakeXhr;
  status = 200;
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
});
