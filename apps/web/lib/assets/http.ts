import { AuthorizationError } from "@archrender/auth";
import { AssetApplicationError, StorageError } from "@archrender/assets";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

export async function readBoundedJson(request: Request, maxBytes = 16_384): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AssetApplicationError("ASSET_INVALID_INPUT", "Content-Type must be application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AssetApplicationError("ASSET_INVALID_INPUT", "Request body is too large.");
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AssetApplicationError("ASSET_INVALID_INPUT", "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AssetApplicationError("ASSET_INVALID_INPUT", "Request body must be valid JSON.");
  }
}

export function assetErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return privateJson(
      { ok: false, code: "ASSET_VALIDATION", issues: error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  if (error instanceof AuthorizationError) {
    return privateJson({ ok: false, code: "ASSET_FORBIDDEN" }, { status: 403 });
  }
  if (error instanceof AssetApplicationError) {
    const statusByCode: Partial<Record<typeof error.code, number>> = {
      ASSET_INVALID_INPUT: 400,
      ASSET_NOT_FOUND: 404,
      ASSET_PROJECT_NOT_FOUND: 404,
      ASSET_IDEMPOTENCY_CONFLICT: 409,
      ASSET_INVALID_STATE: 409,
      ASSET_PROJECT_ARCHIVED: 409,
      ASSET_VERIFICATION_IN_PROGRESS: 409,
      ASSET_UPLOAD_EXPIRED: 410,
      ASSET_QUOTA_EXCEEDED: 413,
      ASSET_VERIFICATION_FAILED: 422,
      ASSET_REFERENCED: 422,
      ASSET_RATE_LIMITED: 429,
      ASSET_CONCURRENT_LIMIT: 429,
      ASSET_STORAGE_UNAVAILABLE: 503,
      ASSET_INTEGRITY_CONFLICT: 503,
    };
    const status = statusByCode[error.code] ?? 422;
    return privateJson(
      { ok: false, code: error.code, retryable: error.retryable },
      {
        status,
        ...(status === 429 ? { headers: { "Retry-After": "60" } } : {}),
      },
    );
  }
  if (error instanceof StorageError) {
    return privateJson(
      { ok: false, code: "ASSET_STORAGE_UNAVAILABLE", retryable: error.retryable },
      { status: 503 },
    );
  }
  const candidate = typeof error === "object" && error !== null
    ? error as { name?: unknown; code?: unknown }
    : {};
  const errorName = typeof candidate.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(candidate.name)
    ? candidate.name
    : "UnknownError";
  const errorCode = typeof candidate.code === "string" && /^[A-Z0-9_]{1,32}$/.test(candidate.code)
    ? candidate.code
    : "UNCLASSIFIED";
  console.error(
    `[assets.api] request failed code=ASSET_UNEXPECTED_ERROR type=${errorName} cause=${errorCode}`,
  );
  return privateJson({ ok: false, code: "ASSET_UNEXPECTED_ERROR" }, { status: 500 });
}
