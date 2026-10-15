import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "@archrender/database";

import { AuthService } from "../../src/auth-service.js";
import { hashSecurityContext, hashSessionToken } from "../../src/crypto.js";
import { hashPassword } from "../../src/password.js";

const database = createDatabaseClient();
const runId = `m2b-${Date.now()}-${randomUUID()}`;
const contextSecret = `integration-only-${randomUUID()}-${randomUUID()}`;
const password = "M2B integration passphrase";
const emailA = `${runId}-a@integration.invalid`;
const emailB = `${runId}-b@integration.invalid`;
const userIds: string[] = [];
const identifierHashes = [
  hashSecurityContext(emailA, contextSecret),
  hashSecurityContext(emailB, contextSecret),
  hashSecurityContext(`${runId}-unknown@integration.invalid`, contextSecret),
  hashSecurityContext(`${runId}-limited@integration.invalid`, contextSecret),
];
const ipHashes = ["login", "unknown", "limited", "session"].map((suffix) =>
  hashSecurityContext(`${runId}-${suffix}`, contextSecret),
);
const auth = new AuthService(database, {
  contextSecret,
  policy: {
    sessionAbsoluteTtlMs: 60 * 60 * 1_000,
    sessionIdleTimeoutMs: 10 * 60 * 1_000,
    sessionRotationIntervalMs: 1_000,
    sessionTouchIntervalMs: 500,
    maxActiveSessions: 2,
    loginWindowMs: 60 * 1_000,
    accountFailureLimit: 2,
    ipFailureLimit: 3,
    cooldownMs: 60 * 1_000,
  },
});

beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  const users = await database.$transaction([
    database.user.create({
      data: {
        email: emailA,
        passwordHash,
        role: "ADMIN",
        displayName: `M2B A ${runId}`,
      },
    }),
    database.user.create({
      data: {
        email: emailB,
        passwordHash,
        role: "ADMIN",
        displayName: `M2B B ${runId}`,
      },
    }),
  ]);
  userIds.push(...users.map(({ id }) => id));
});

afterAll(async () => {
  try {
    await database.$transaction(async (transaction) => {
      await transaction.activityLog.deleteMany({ where: { ownerId: { in: userIds } } });
      await transaction.session.deleteMany({ where: { userId: { in: userIds } } });
      await transaction.loginAttempt.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { identifierHash: { in: identifierHashes } },
            { ipHash: { in: ipHashes } },
          ],
        },
      });
      await transaction.user.deleteMany({ where: { id: { in: userIds } } });
    });
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  } finally {
    await database.$disconnect();
  }
});

describe.sequential("database-backed authentication", () => {
  it("uses generic failures for wrong passwords and unknown users", async () => {
    const wrong = await auth.login({
      email: emailA,
      password: "wrong password with enough input",
      ipAddress: `${runId}-login`,
    });
    const unknown = await auth.login({
      email: `${runId}-unknown@integration.invalid`,
      password: "wrong password with enough input",
      ipAddress: `${runId}-unknown`,
    });
    expect(wrong.status).toBe("invalid");
    expect(unknown.status).toBe("invalid");
  });

  it("creates, validates, rotates, limits, revokes, and expires sessions", async () => {
    const first = await auth.login({
      email: emailA,
      password,
      ipAddress: `${runId}-session`,
      userAgent: "ArchRender integration test",
    });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("Expected successful login.");
    await expect(auth.validateSession(first.token)).resolves.toMatchObject({ status: "valid" });

    const second = await auth.login({
      email: emailA,
      password,
      ipAddress: `${runId}-session`,
    });
    const third = await auth.login({
      email: emailA,
      password,
      ipAddress: `${runId}-session`,
    });
    expect(second.status).toBe("success");
    expect(third.status).toBe("success");
    expect(
      await database.session.count({
        where: { userId: userIds[0]!, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ).toBe(2);

    if (third.status !== "success") throw new Error("Expected successful login.");
    const rotationTime = new Date(Date.now() + 2_000);
    const rotated = await auth.validateSession(third.token, {
      now: rotationTime,
      rotate: true,
    });
    expect(rotated.status).toBe("valid");
    if (rotated.status !== "valid" || !rotated.rotatedToken) {
      throw new Error("Expected session rotation.");
    }
    await expect(auth.validateSession(third.token)).resolves.toEqual({ status: "invalid" });
    await auth.logout(rotated.rotatedToken);
    await expect(auth.validateSession(rotated.rotatedToken)).resolves.toEqual({ status: "invalid" });

    const expiredToken = `expired-${randomUUID()}`;
    const expiredSession = await database.session.create({
      data: {
        userId: userIds[0]!,
        tokenHash: hashSessionToken(expiredToken),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    await expect(auth.validateSession(expiredToken)).resolves.toEqual({ status: "invalid" });
    expect((await database.session.findUnique({ where: { id: expiredSession.id } }))?.revokedAt).not.toBeNull();
  });

  it("persists cooldowns across service instances", async () => {
    const limitedEmail = `${runId}-limited@integration.invalid`;
    const passwordHash = await hashPassword(password);
    const limited = await database.user.create({
      data: { email: limitedEmail, passwordHash, role: "ADMIN" },
    });
    userIds.push(limited.id);
    const request = {
      email: limitedEmail,
      password: "incorrect but non-empty password",
      ipAddress: `${runId}-limited`,
    };
    expect((await auth.login(request)).status).toBe("invalid");
    expect((await auth.login(request)).status).toBe("blocked");
    const secondInstance = new AuthService(database, {
      contextSecret,
      policy: {
        sessionAbsoluteTtlMs: 60 * 60 * 1_000,
        sessionIdleTimeoutMs: 10 * 60 * 1_000,
        sessionRotationIntervalMs: 1_000,
        sessionTouchIntervalMs: 500,
        maxActiveSessions: 2,
        loginWindowMs: 60 * 1_000,
        accountFailureLimit: 2,
        ipFailureLimit: 3,
        cooldownMs: 60 * 1_000,
      },
    });
    expect((await secondInstance.login(request)).status).toBe("blocked");
  });
});
