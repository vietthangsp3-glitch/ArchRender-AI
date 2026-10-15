import "server-only";

import { AuthService, requireContextSecret } from "@archrender/auth";
import { getDatabaseClient } from "@archrender/database";

let authService: AuthService | undefined;

export function getAuthService(): AuthService {
  authService ??= new AuthService(getDatabaseClient(), {
    contextSecret: requireContextSecret(),
  });
  return authService;
}
