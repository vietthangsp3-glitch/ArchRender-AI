export type JobErrorCode =
  | "JOB_INVALID_INPUT"
  | "JOB_NOT_FOUND"
  | "JOB_PROJECT_NOT_FOUND"
  | "JOB_PROJECT_ARCHIVED"
  | "JOB_ASSET_INVALID"
  | "JOB_WORKFLOW_INVALID"
  | "JOB_IDEMPOTENCY_CONFLICT"
  | "JOB_INVALID_STATE"
  | "JOB_RATE_LIMITED"
  | "JOB_QUEUE_LIMIT"
  | "JOB_STALE_WORKER"
  | "JOB_RETRY_EXHAUSTED";

export class JobApplicationError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "JobApplicationError";
  }
}
