import type { UserRole } from "@archrender/database";

import { AuthorizationError } from "./errors";

export interface AuthenticatedPrincipal {
  id: string;
  role: UserRole;
}

export function requireOwnerScope(
  principal: AuthenticatedPrincipal,
  ownerId: string,
): void {
  if (principal.id !== ownerId) throw new AuthorizationError();
}

export function requireRole(
  principal: AuthenticatedPrincipal,
  allowedRoles: readonly UserRole[],
): void {
  if (!allowedRoles.includes(principal.role)) throw new AuthorizationError();
}
