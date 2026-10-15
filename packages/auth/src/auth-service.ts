import type { PrismaClient, UserRole } from "@archrender/database";

import { DEFAULT_AUTH_POLICY, type AuthPolicy } from "./config";
import {
  generateSessionToken,
  hashSecurityContext,
  hashSessionToken,
} from "./crypto";
import { verifyPassword, verifyPasswordWithoutUser } from "./password";
import { loginInputSchema } from "./validation";

export interface LoginRequest {
  email: string;
  password: string;
  ipAddress: string;
  userAgent?: string;
  now?: Date;
}

export type LoginResult =
  | { status: "success"; token: string; expiresAt: Date; user: SessionUser }
  | { status: "invalid" }
  | { status: "blocked"; retryAt: Date };

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
}

export type SessionValidationResult =
  | { status: "invalid" }
  | {
      status: "valid";
      sessionId: string;
      expiresAt: Date;
      user: SessionUser;
      rotatedToken?: string;
    };

export interface AuthServiceOptions {
  contextSecret: string;
  policy?: AuthPolicy;
}

export class AuthService {
  private readonly policy: AuthPolicy;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: AuthServiceOptions,
  ) {
    this.policy = options.policy ?? DEFAULT_AUTH_POLICY;
  }

  async login(request: LoginRequest): Promise<LoginResult> {
    const parsed = loginInputSchema.safeParse(request);
    if (!parsed.success) {
      await verifyPasswordWithoutUser(request.password);
      return { status: "invalid" };
    }

    const now = request.now ?? new Date();
    const email = parsed.data.email;
    const identifierHash = hashSecurityContext(email, this.options.contextSecret);
    const ipHash = hashSecurityContext(request.ipAddress, this.options.contextSecret);
    const enforceIpLimit = !["untrusted-proxy", "unavailable"].includes(
      request.ipAddress,
    );
    const activeBlock = await this.database.loginAttempt.findFirst({
      where: {
        blockedUntil: { gt: now },
        OR: [{ identifierHash }, ...(enforceIpLimit ? [{ ipHash }] : [])],
      },
      orderBy: { blockedUntil: "desc" },
    });

    if (activeBlock?.blockedUntil) {
      await this.recordAttempt({
        identifierHash,
        ipHash,
        outcome: "BLOCKED",
        blockedUntil: activeBlock.blockedUntil,
        now,
      });
      return { status: "blocked", retryAt: activeBlock.blockedUntil };
    }

    const windowStart = new Date(now.getTime() - this.policy.loginWindowMs);
    const [accountFailures, ipFailures, user] = await Promise.all([
      this.database.loginAttempt.count({
        where: { identifierHash, outcome: "FAILURE", createdAt: { gte: windowStart } },
      }),
      enforceIpLimit
        ? this.database.loginAttempt.count({
            where: { ipHash, outcome: "FAILURE", createdAt: { gte: windowStart } },
          })
        : Promise.resolve(0),
      this.database.user.findUnique({ where: { email } }),
    ]);

    if (
      accountFailures >= this.policy.accountFailureLimit ||
      ipFailures >= this.policy.ipFailureLimit
    ) {
      const retryAt = new Date(now.getTime() + this.policy.cooldownMs);
      await this.recordAttempt({
        identifierHash,
        ipHash,
        outcome: "BLOCKED",
        blockedUntil: retryAt,
        ...(user ? { userId: user.id } : {}),
        now,
      });
      return { status: "blocked", retryAt };
    }

    const passwordMatches = user
      ? await verifyPassword(user.passwordHash, request.password).catch(() => false)
      : (await verifyPasswordWithoutUser(request.password), false);

    if (!user || !passwordMatches || user.disabledAt) {
      const shouldBlock =
        accountFailures + 1 >= this.policy.accountFailureLimit ||
        ipFailures + 1 >= this.policy.ipFailureLimit;
      const blockedUntil = shouldBlock
        ? new Date(now.getTime() + this.policy.cooldownMs)
        : undefined;
      await this.recordAttempt({
        identifierHash,
        ipHash,
        outcome: "FAILURE",
        ...(blockedUntil ? { blockedUntil } : {}),
        ...(user ? { userId: user.id } : {}),
        now,
      });
      return blockedUntil
        ? { status: "blocked", retryAt: blockedUntil }
        : { status: "invalid" };
    }

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(now.getTime() + this.policy.sessionAbsoluteTtlMs);

    await this.database.$transaction(async (transaction) => {
      const activeSessions = await transaction.session.findMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const sessionsToRevoke = activeSessions.slice(this.policy.maxActiveSessions - 1);
      if (sessionsToRevoke.length > 0) {
        await transaction.session.updateMany({
          where: { id: { in: sessionsToRevoke.map(({ id }) => id) } },
          data: { revokedAt: now },
        });
      }
      await transaction.session.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
          lastSeenAt: now,
          userAgent: request.userAgent?.slice(0, 512) ?? null,
          ipHash,
        },
      });
      await transaction.loginAttempt.create({
        data: { userId: user.id, identifierHash, ipHash, outcome: "SUCCESS", createdAt: now },
      });
      await transaction.activityLog.create({
        data: {
          ownerId: user.id,
          actorUserId: user.id,
          action: "AUTH_LOGIN_SUCCEEDED",
          entityType: "SESSION",
          ipHash,
          createdAt: now,
        },
      });
    });

    return {
      status: "success",
      token,
      expiresAt,
      user: this.toSessionUser(user),
    };
  }

  async validateSession(
    token: string | null | undefined,
    options: { now?: Date; rotate?: boolean } = {},
  ): Promise<SessionValidationResult> {
    if (!token || token.length > 256) return { status: "invalid" };
    const now = options.now ?? new Date();
    const tokenHash = hashSessionToken(token);
    const session = await this.database.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.user.disabledAt) return { status: "invalid" };

    const lastActivity = session.lastSeenAt ?? session.createdAt;
    const idleExpired =
      now.getTime() - lastActivity.getTime() > this.policy.sessionIdleTimeoutMs;
    if (session.expiresAt <= now || idleExpired) {
      await this.database.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      return { status: "invalid" };
    }

    const shouldRotate =
      options.rotate === true &&
      now.getTime() - session.updatedAt.getTime() >= this.policy.sessionRotationIntervalMs;
    if (shouldRotate) {
      const rotatedToken = generateSessionToken();
      const rotatedTokenHash = hashSessionToken(rotatedToken);
      const expiresAt = new Date(now.getTime() + this.policy.sessionAbsoluteTtlMs);
      const rotated = await this.database.$transaction(async (transaction) => {
        const claimed = await transaction.session.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        });
        if (claimed.count !== 1) return false;
        await transaction.session.create({
          data: {
            userId: session.userId,
            tokenHash: rotatedTokenHash,
            expiresAt,
            lastSeenAt: now,
            userAgent: session.userAgent,
            ipHash: session.ipHash,
          },
        });
        return true;
      });
      if (!rotated) return { status: "invalid" };
      return {
        status: "valid",
        sessionId: session.id,
        expiresAt,
        user: this.toSessionUser(session.user),
        rotatedToken,
      };
    }

    if (now.getTime() - lastActivity.getTime() >= this.policy.sessionTouchIntervalMs) {
      await this.database.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now },
      });
    }

    return {
      status: "valid",
      sessionId: session.id,
      expiresAt: session.expiresAt,
      user: this.toSessionUser(session.user),
    };
  }

  async logout(token: string | null | undefined, now = new Date()): Promise<void> {
    if (!token || token.length > 256) return;
    const tokenHash = hashSessionToken(token);
    const session = await this.database.session.findUnique({ where: { tokenHash } });
    if (!session || session.revokedAt) return;
    await this.database.$transaction([
      this.database.session.update({
        where: { id: session.id },
        data: { revokedAt: now },
      }),
      this.database.activityLog.create({
        data: {
          ownerId: session.userId,
          actorUserId: session.userId,
          action: "AUTH_LOGOUT",
          entityType: "SESSION",
          entityId: session.id,
          ipHash: session.ipHash,
          createdAt: now,
        },
      }),
    ]);
  }

  private recordAttempt(input: {
    identifierHash: string;
    ipHash: string;
    outcome: "FAILURE" | "BLOCKED";
    blockedUntil?: Date;
    userId?: string;
    now: Date;
  }) {
    return this.database.loginAttempt.create({
      data: {
        identifierHash: input.identifierHash,
        ipHash: input.ipHash,
        outcome: input.outcome,
        blockedUntil: input.blockedUntil ?? null,
        userId: input.userId ?? null,
        createdAt: input.now,
      },
    });
  }

  private toSessionUser(user: {
    id: string;
    email: string;
    displayName: string | null;
    role: UserRole;
  }): SessionUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };
  }
}
