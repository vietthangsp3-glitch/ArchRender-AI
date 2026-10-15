export type AssetErrorCode =
  | "ASSET_INVALID_INPUT"
  | "ASSET_INVALID_STATE"
  | "ASSET_NOT_FOUND"
  | "ASSET_PROJECT_NOT_FOUND"
  | "ASSET_PROJECT_ARCHIVED"
  | "ASSET_IDEMPOTENCY_CONFLICT"
  | "ASSET_UPLOAD_EXPIRED"
  | "ASSET_REFERENCED"
  | "ASSET_STORAGE_UNAVAILABLE"
  | "ASSET_RATE_LIMITED"
  | "ASSET_CONCURRENT_LIMIT"
  | "ASSET_QUOTA_EXCEEDED"
  | "ASSET_VERIFICATION_FAILED"
  | "ASSET_VERIFICATION_IN_PROGRESS"
  | "ASSET_INTEGRITY_CONFLICT";

export class AssetApplicationError extends Error {
  constructor(
    public readonly code: AssetErrorCode,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AssetApplicationError";
  }
}

export type StorageErrorCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "THROTTLED"
  | "PRECONDITION_FAILED"
  | "UNAVAILABLE";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    public readonly operation: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
    public readonly providerHttpStatus: number | null = null,
  ) {
    super(`Storage operation failed (${code}).`, options);
    this.name = "StorageError";
  }
}

export type CompletionPhase =
  | "claim"
  | "conditional_staging_read"
  | "verify"
  | "final_put"
  | "final_readback"
  | "commit";

export interface CompletionTrace {
  correlationId: string;
  phase: CompletionPhase;
}

export interface SafeCompletionDiagnostic {
  correlationId: string;
  phase: CompletionPhase;
  classification: "r2" | "db" | "transport" | "timeout" | "validation";
  operation: string | null;
  storageCode: StorageErrorCode | null;
  providerHttpStatus: number | null;
  applicationCode: AssetErrorCode | null;
  httpStatus: number;
}

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

export function createSafeCompletionDiagnostic(
  trace: CompletionTrace,
  error: unknown,
  httpStatus: number,
): SafeCompletionDiagnostic {
  const chain = errorChain(error);
  const storage = chain.find((candidate): candidate is StorageError => candidate instanceof StorageError) ?? null;
  const application = chain.find((candidate): candidate is AssetApplicationError => candidate instanceof AssetApplicationError) ?? null;
  const database = chain.some((candidate) => {
    if (!(candidate instanceof Error)) return false;
    const code = (candidate as Error & { code?: unknown }).code;
    return candidate.name.startsWith("PrismaClient") || (typeof code === "string" && /^P[0-9]{4}$/.test(code));
  });
  const classification = storage?.code === "TIMEOUT"
    ? "timeout"
    : storage
      ? "r2"
      : database
        ? "db"
        : application
          ? "validation"
          : "transport";
  return {
    correlationId: trace.correlationId,
    phase: trace.phase,
    classification,
    operation: storage?.operation ?? null,
    storageCode: storage?.code ?? null,
    providerHttpStatus: storage?.providerHttpStatus ?? null,
    applicationCode: application?.code ?? null,
    httpStatus,
  };
}

type ProviderErrorShape = {
  name?: unknown;
  Code?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: unknown };
};

export function mapStorageError(error: unknown, operation: string): StorageError {
  if (error instanceof StorageError) return error;
  const candidate = (typeof error === "object" && error !== null ? error : {}) as ProviderErrorShape;
  const name = String(candidate.name ?? candidate.Code ?? candidate.code ?? "");
  const status = Number(candidate.$metadata?.httpStatusCode ?? 0);

  if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
    return new StorageError("NOT_FOUND", operation, false, { cause: error }, status || null);
  }
  if (status === 401 || status === 403 || name === "AccessDenied") {
    return new StorageError("ACCESS_DENIED", operation, false, { cause: error }, status || null);
  }
  if (status === 408 || name.includes("Timeout")) {
    return new StorageError("TIMEOUT", operation, true, { cause: error }, status || null);
  }
  if (status === 429 || name === "SlowDown" || name.includes("Throttl")) {
    return new StorageError("THROTTLED", operation, true, { cause: error }, status || null);
  }
  if (status === 412 || name === "PreconditionFailed") {
    return new StorageError("PRECONDITION_FAILED", operation, false, { cause: error }, status || null);
  }
  return new StorageError("UNAVAILABLE", operation, true, { cause: error }, status || null);
}

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|signature|token|url/i;

export function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveData(item),
    ]),
  );
}
