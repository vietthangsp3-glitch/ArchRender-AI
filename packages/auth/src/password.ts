import { randomBytes } from "node:crypto";

import argon2 from "argon2";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

let dummyHashPromise: Promise<string> | undefined;

export function validatePasswordPolicy(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 14) errors.push("Password must contain at least 14 characters.");
  if (password.length > 128) errors.push("Password must contain at most 128 characters.");
  return errors;
}

export function hashPassword(password: string): Promise<string> {
  const errors = validatePasswordPolicy(password);
  if (errors.length > 0) throw new Error(errors[0]);
  return argon2.hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return argon2.verify(passwordHash, password);
}

export async function verifyPasswordWithoutUser(password: string): Promise<void> {
  dummyHashPromise ??= argon2.hash(randomBytes(32).toString("base64url"), ARGON2_OPTIONS);
  const dummyHash = await dummyHashPromise;
  await argon2.verify(dummyHash, password).catch(() => false);
}
