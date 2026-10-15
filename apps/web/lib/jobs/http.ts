import { AuthorizationError } from "@archrender/auth";
import { JobApplicationError } from "@archrender/jobs";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

export function jobJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { ...privateHeaders, ...init?.headers } });
}

export async function readJobJson(request: Request, maxBytes = 32_768) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new JobApplicationError("JOB_INVALID_INPUT", "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new JobApplicationError("JOB_INVALID_INPUT", "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new JobApplicationError("JOB_INVALID_INPUT", "Request body is too large.");
  }
  try { return JSON.parse(text) as unknown; } catch {
    throw new JobApplicationError("JOB_INVALID_INPUT", "Request body must be valid JSON.");
  }
}

export function jobErrorResponse(error: unknown) {
  if (error instanceof ZodError) {
    return jobJson({ ok: false, code: "JOB_VALIDATION", issues: error.flatten().fieldErrors }, { status: 400 });
  }
  if (error instanceof AuthorizationError) return jobJson({ ok: false, code: "JOB_FORBIDDEN" }, { status: 403 });
  if (error instanceof JobApplicationError) {
    const statuses: Partial<Record<typeof error.code, number>> = {
      JOB_INVALID_INPUT: 400,
      JOB_NOT_FOUND: 404,
      JOB_PROJECT_NOT_FOUND: 404,
      JOB_PROJECT_ARCHIVED: 409,
      JOB_ASSET_INVALID: 422,
      JOB_WORKFLOW_INVALID: 422,
      JOB_IDEMPOTENCY_CONFLICT: 409,
      JOB_INVALID_STATE: 409,
      JOB_RETRY_EXHAUSTED: 409,
      JOB_RATE_LIMITED: 429,
      JOB_QUEUE_LIMIT: 429,
      JOB_STALE_WORKER: 409,
    };
    const status = statuses[error.code] ?? 422;
    return jobJson({ ok: false, code: error.code, retryable: error.retryable }, {
      status,
      ...(status === 429 ? { headers: { "Retry-After": "60" } } : {}),
    });
  }
  const candidate = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
  const name = typeof candidate.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate.name) ? candidate.name : "UnknownError";
  const code = typeof candidate.code === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate.code) ? candidate.code : "UNCLASSIFIED";
  console.error(`[jobs.api] request failed type=${name} cause=${code}`);
  return jobJson({ ok: false, code: "JOB_UNEXPECTED_ERROR" }, { status: 500 });
}
