export type ConcurrentHttpErrorCategory =
  | "TIMEOUT"
  | "ABORT"
  | "TRANSPORT_UNKNOWN"
  | "MALFORMED_RESPONSE"
  | "CLIENT_ERROR";

export interface ConcurrentHttpResponse {
  status: number;
  code?: unknown;
}

export type ConcurrentHttpOutcome =
  | {
      kind: "HTTP";
      status: number;
      safeCode: string;
      elapsedMs: number;
    }
  | {
      kind: "REJECTION";
      errorName: string;
      category: ConcurrentHttpErrorCategory;
      status: number | null;
      elapsedMs: number;
    };

function safeName(error: unknown) {
  const value = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : "UnknownError";
}

function safeStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const value = Number(error.status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function classify(error: unknown, timedOut: boolean): ConcurrentHttpErrorCategory {
  if (timedOut) return "TIMEOUT";
  if (error instanceof Error && error.name === "AbortError") return "ABORT";
  if (error instanceof Error && error.name === "MalformedResponseError") return "MALFORMED_RESPONSE";
  if (error instanceof TypeError) return "TRANSPORT_UNKNOWN";
  return "CLIENT_ERROR";
}

async function settleOne(
  operation: (signal: AbortSignal) => Promise<ConcurrentHttpResponse>,
  timeoutMs: number,
): Promise<ConcurrentHttpOutcome> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await operation(controller.signal);
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
      const malformed = new Error("MALFORMED_RESPONSE");
      malformed.name = "MalformedResponseError";
      throw malformed;
    }
    const code = response.code;
    return {
      kind: "HTTP",
      status: response.status,
      safeCode: typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "NO_CODE",
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    return {
      kind: "REJECTION",
      errorName: safeName(error),
      category: classify(error, timedOut),
      status: safeStatus(error),
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function settleConcurrentHttpRequests(
  operations: Array<(signal: AbortSignal) => Promise<ConcurrentHttpResponse>>,
  timeoutMs = 30_000,
): Promise<ConcurrentHttpOutcome[]> {
  if (operations.length < 2 || operations.length > 4 || !Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error("CONCURRENT_HTTP_POLICY_INVALID");
  }
  return Promise.all(operations.map((operation) => settleOne(operation, timeoutMs)));
}

export function formatSafeConcurrentOutcome(outcome: ConcurrentHttpOutcome) {
  if (outcome.kind === "HTTP") {
    return `${outcome.status}_${outcome.safeCode}_${outcome.elapsedMs}MS`;
  }
  return `REJECTED_${outcome.errorName}_${outcome.category}_${outcome.status ?? "NO_STATUS"}_${outcome.elapsedMs}MS`;
}
