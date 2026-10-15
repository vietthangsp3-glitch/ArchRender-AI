import type { PrismaClient } from "@archrender/database";
import { describe, expect, it, vi } from "vitest";

import { requireOwnerScope, requireRole } from "../src/authorization.js";
import { bootstrapOwner } from "../src/bootstrap-owner.js";
import { generateSessionToken, hashSecurityContext, hashSessionToken } from "../src/crypto.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../src/password.js";
import { safeReturnTo } from "../src/validation.js";

describe("authentication security primitives", () => {
  it("creates opaque tokens and stores only stable hashes", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSecurityContext("owner@example.com", "x".repeat(32))).toHaveLength(64);
  });

  it("hashes and verifies passwords with Argon2id", async () => {
    const password = "a secure test passphrase";
    const hash = await hashPassword(password);
    expect(hash).toContain("$argon2id$");
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, "incorrect password value")).resolves.toBe(false);
  });

  it("enforces password length without destructive trimming", () => {
    expect(validatePasswordPolicy("too-short")).not.toHaveLength(0);
    expect(validatePasswordPolicy("correct horse battery staple")).toHaveLength(0);
  });

  it("prevents open redirects", () => {
    expect(safeReturnTo("/projects?view=recent")).toBe("/projects?view=recent");
    expect(safeReturnTo("https://evil.example/steal")).toBe("/");
    expect(safeReturnTo("//evil.example/steal")).toBe("/");
  });

  it("centralizes role and owner authorization", () => {
    const principal = { id: "owner-a", role: "OWNER" as const };
    expect(() => requireOwnerScope(principal, "owner-a")).not.toThrow();
    expect(() => requireOwnerScope(principal, "owner-b")).toThrow("Access denied");
    expect(() => requireRole(principal, ["OWNER"])).not.toThrow();
    expect(() => requireRole(principal, ["ADMIN"])).toThrow("Access denied");
  });

  it("allows OWNER bootstrap only once", async () => {
    let existingOwner = false;
    const create = vi.fn(async () => {
      existingOwner = true;
      return { id: "owner-test-id" };
    });
    const transaction = {
      user: {
        findFirst: vi.fn(async () => (existingOwner ? { id: "owner-test-id" } : null)),
        create,
      },
      activityLog: { create: vi.fn(async () => ({ id: "activity-test-id" })) },
    };
    const database = {
      $transaction: (work: (client: typeof transaction) => Promise<unknown>) => work(transaction),
    } as unknown as PrismaClient;
    const input = {
      email: "owner@integration.invalid",
      password: "a secure bootstrap passphrase",
      displayName: "Owner Test",
    };

    await expect(bootstrapOwner(database, input)).resolves.toMatchObject({ status: "created" });
    await expect(bootstrapOwner(database, input)).resolves.toEqual({
      status: "already_bootstrapped",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
