type ErrorWithCode = {
  code?: unknown;
  constructor?: { name?: unknown };
};

export type LoginFailureStep = "request_parse" | "authentication" | "response_cookie";

export function classifyLoginFailure(error: unknown): string {
  if (!(error instanceof Error)) return "AUTH_UNEXPECTED_NON_ERROR";

  const candidate = error as Error & ErrorWithCode;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const errorType =
    typeof candidate.constructor?.name === "string" ? candidate.constructor.name : "";

  if (/^P\d{4}$/.test(code)) return `AUTH_DATABASE_${code}`;
  if (/^[A-Z0-9_-]{2,32}$/.test(code)) return `AUTH_RUNTIME_${code}`;
  if (errorType === "PrismaClientInitializationError") {
    return "AUTH_DATABASE_INITIALIZATION";
  }
  if (errorType === "PrismaClientValidationError") {
    return "AUTH_DATABASE_VALIDATION";
  }
  if (errorType === "PrismaClientKnownRequestError") {
    return "AUTH_DATABASE_KNOWN_REQUEST";
  }
  if (errorType === "PrismaClientUnknownRequestError") {
    return "AUTH_DATABASE_UNKNOWN_REQUEST";
  }
  if (errorType.startsWith("PrismaClient")) return "AUTH_DATABASE_QUERY";
  if (code === "ERR_DLOPEN_FAILED" || code === "MODULE_NOT_FOUND") {
    return "AUTH_PASSWORD_RUNTIME";
  }
  if (error.message === "AUTH_CONTEXT_SECRET must contain at least 32 bytes.") {
    return "AUTH_CONTEXT_SECRET_INVALID";
  }
  if (error.message.startsWith("DATABASE_URL is required.")) {
    return "AUTH_DATABASE_URL_MISSING";
  }

  return "AUTH_UNEXPECTED_ERROR";
}

export function logLoginFailure(step: LoginFailureStep, code: string): void {
  console.error(`[auth.login] request failed step=${step} code=${code}`);
}
