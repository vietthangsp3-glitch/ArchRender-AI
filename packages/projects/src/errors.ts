export type ProjectErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_CONFLICT"
  | "PROJECT_ARCHIVED"
  | "PROJECT_INVALID_TRANSITION";

export class ProjectApplicationError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectApplicationError";
  }
}
