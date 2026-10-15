export interface DirectUploadInput {
  url: string;
  file: Blob;
  requiredHeaders: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface DirectUploadResult {
  etag: string | null;
}

export function browserUploadHeaders(headers: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
}

export function uploadDirectlyToStorage(input: DirectUploadInput): Promise<DirectUploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", input.url);
    request.timeout = input.timeoutMs ?? 60_000;
    for (const [name, value] of Object.entries(browserUploadHeaders(input.requiredHeaders))) {
      request.setRequestHeader(name, value);
    }
    const abort = () => request.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    request.upload.addEventListener("progress", (event) => {
      input.onProgress?.(event.loaded, event.lengthComputable ? event.total : input.file.size);
    });
    request.addEventListener("load", () => {
      input.signal?.removeEventListener("abort", abort);
      if (request.status >= 200 && request.status < 300) {
        resolve({ etag: request.getResponseHeader("ETag") });
      } else {
        reject(new Error(`Direct upload failed with status ${request.status}.`));
      }
    });
    request.addEventListener("error", () => reject(new Error("Direct upload network failure.")));
    request.addEventListener("timeout", () => reject(new Error("Direct upload timed out.")));
    request.addEventListener("abort", () => reject(new DOMException("Upload aborted.", "AbortError")));
    request.send(input.file);
  });
}
