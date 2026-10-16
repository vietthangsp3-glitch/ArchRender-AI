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

export type DirectUploadErrorCode =
  | "DIRECT_UPLOAD_HTTP_ERROR"
  | "DIRECT_UPLOAD_NETWORK_ERROR"
  | "DIRECT_UPLOAD_TIMEOUT";

export type DirectUploadProviderCode =
  | "R2_SIGNATURE_MISMATCH"
  | "R2_ACCESS_DENIED"
  | "R2_INVALID_ACCESS_KEY"
  | "R2_INVALID_TOKEN"
  | "R2_BUCKET_NOT_FOUND"
  | "R2_REQUEST_EXPIRED"
  | "R2_OTHER_ERROR";

export class DirectUploadError extends Error {
  constructor(
    public readonly code: DirectUploadErrorCode,
    public readonly httpStatus?: number,
    public readonly providerCode?: DirectUploadProviderCode,
  ) {
    super(code);
    this.name = "DirectUploadError";
  }
}

export function classifyR2ErrorResponse(responseText: string): DirectUploadProviderCode {
  const code = responseText.slice(0, 4_096).match(/<Code>\s*([A-Za-z0-9]+)\s*<\/Code>/)?.[1];
  switch (code) {
    case "SignatureDoesNotMatch": return "R2_SIGNATURE_MISMATCH";
    case "AccessDenied": return "R2_ACCESS_DENIED";
    case "InvalidAccessKeyId": return "R2_INVALID_ACCESS_KEY";
    case "InvalidToken":
    case "ExpiredToken": return "R2_INVALID_TOKEN";
    case "NoSuchBucket": return "R2_BUCKET_NOT_FOUND";
    case "RequestExpired":
    case "RequestTimeTooSkewed": return "R2_REQUEST_EXPIRED";
    default: return "R2_OTHER_ERROR";
  }
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
        reject(new DirectUploadError(
          "DIRECT_UPLOAD_HTTP_ERROR",
          request.status >= 100 && request.status <= 599 ? request.status : undefined,
          classifyR2ErrorResponse(request.responseText),
        ));
      }
    });
    request.addEventListener("error", () => reject(new DirectUploadError("DIRECT_UPLOAD_NETWORK_ERROR")));
    request.addEventListener("timeout", () => reject(new DirectUploadError("DIRECT_UPLOAD_TIMEOUT")));
    request.addEventListener("abort", () => reject(new DOMException("Upload aborted.", "AbortError")));
    request.send(input.file);
  });
}
