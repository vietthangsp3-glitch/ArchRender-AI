export { AuthService } from "./auth-service";
export type {
  AuthServiceOptions,
  LoginRequest,
  LoginResult,
  SessionUser,
  SessionValidationResult,
} from "./auth-service";
export { requireOwnerScope, requireRole } from "./authorization";
export type { AuthenticatedPrincipal } from "./authorization";
export { bootstrapOwner } from "./bootstrap-owner";
export type { BootstrapOwnerResult } from "./bootstrap-owner";
export { DEFAULT_AUTH_POLICY, requireContextSecret } from "./config";
export type { AuthPolicy } from "./config";
export { generateSessionToken, hashSecurityContext, hashSessionToken } from "./crypto";
export { AuthorizationError } from "./errors";
export { hashPassword, validatePasswordPolicy, verifyPassword } from "./password";
export { bootstrapOwnerInputSchema, loginInputSchema, safeReturnTo } from "./validation";
