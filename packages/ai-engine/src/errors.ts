export type AiEngineErrorCode =
  | "AI_ENGINE_DISCONNECTED"
  | "AI_ENGINE_INVALID_INPUT"
  | "AI_ENGINE_MODEL_UNAVAILABLE"
  | "AI_ENGINE_CAPABILITY_MISSING"
  | "AI_ENGINE_AUTH_FAILED"
  | "AI_ENGINE_TIMEOUT"
  | "AI_ENGINE_TRANSPORT"
  | "AI_ENGINE_PROVIDER_REJECTED"
  | "AI_ENGINE_OUTPUT_INVALID"
  | "AI_ENGINE_CANCELLED";

export class AiEngineError extends Error {
  constructor(
    readonly code: AiEngineErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiEngineError";
  }
}

export function safeEngineError(error: unknown): {
  code: AiEngineErrorCode;
  retryable: boolean;
} {
  if (error instanceof AiEngineError) return { code: error.code, retryable: error.retryable };
  return { code: "AI_ENGINE_TRANSPORT", retryable: true };
}
