export interface AuthPolicy {
  sessionAbsoluteTtlMs: number;
  sessionIdleTimeoutMs: number;
  sessionRotationIntervalMs: number;
  sessionTouchIntervalMs: number;
  maxActiveSessions: number;
  loginWindowMs: number;
  accountFailureLimit: number;
  ipFailureLimit: number;
  cooldownMs: number;
}

export const DEFAULT_AUTH_POLICY: Readonly<AuthPolicy> = Object.freeze({
  sessionAbsoluteTtlMs: 12 * 60 * 60 * 1_000,
  sessionIdleTimeoutMs: 30 * 60 * 1_000,
  sessionRotationIntervalMs: 15 * 60 * 1_000,
  sessionTouchIntervalMs: 5 * 60 * 1_000,
  maxActiveSessions: 5,
  loginWindowMs: 15 * 60 * 1_000,
  accountFailureLimit: 5,
  ipFailureLimit: 25,
  cooldownMs: 15 * 60 * 1_000,
});

export function requireContextSecret(value = process.env["AUTH_CONTEXT_SECRET"]): string {
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("AUTH_CONTEXT_SECRET must contain at least 32 bytes.");
  }
  return value;
}
