export class AuthorizationError extends Error {
  constructor() {
    super("Access denied.");
    this.name = "AuthorizationError";
  }
}
