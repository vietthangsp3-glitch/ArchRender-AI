export type SafeR2DiagnosticCode =
  | "SIGNATURE_MISMATCH"
  | "ACCESS_DENIED"
  | "INVALID_ACCESS_KEY"
  | "INVALID_TOKEN"
  | "BUCKET_NOT_FOUND"
  | "REQUEST_EXPIRED"
  | "OTHER_R2_ERROR";

export function classifyR2DiagnosticBody(body: string): SafeR2DiagnosticCode {
  const code = body.slice(0, 4_096).match(/<Code>\s*([A-Za-z0-9]+)\s*<\/Code>/)?.[1];
  switch (code) {
    case "SignatureDoesNotMatch": return "SIGNATURE_MISMATCH";
    case "AccessDenied": return "ACCESS_DENIED";
    case "InvalidAccessKeyId": return "INVALID_ACCESS_KEY";
    case "InvalidToken":
    case "ExpiredToken": return "INVALID_TOKEN";
    case "NoSuchBucket": return "BUCKET_NOT_FOUND";
    case "RequestExpired":
    case "RequestTimeTooSkewed": return "REQUEST_EXPIRED";
    default: return "OTHER_R2_ERROR";
  }
}

export function assertSerializedUploadContract(input: {
  url: string;
  requiredHeaders: Readonly<Record<string, string>>;
  contentType: string;
  contentLength: number;
  assetId: string;
}) {
  const url = new URL(input.url);
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
  if (
    input.requiredHeaders["content-type"] !== input.contentType ||
    input.requiredHeaders["content-length"] !== String(input.contentLength) ||
    input.requiredHeaders["x-amz-meta-assetid"] !== input.assetId ||
    signedHeaders.join(";") !== "content-length;content-type;host;x-amz-meta-assetid"
  ) {
    throw new Error("SIGNED_UPLOAD_CONTRACT_MISMATCH");
  }
}
