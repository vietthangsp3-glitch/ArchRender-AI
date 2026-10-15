import { AssetApplicationError } from "./errors";
import type { AssetLifecycleStatus } from "./types";

const ALLOWED_TRANSITIONS: Readonly<Record<AssetLifecycleStatus, readonly AssetLifecycleStatus[]>> = {
  PENDING_UPLOAD: ["VERIFYING", "REJECTED", "DELETED"],
  VERIFYING: ["PENDING_UPLOAD", "READY", "REJECTED", "DELETED"],
  READY: ["DELETED"],
  REJECTED: ["PENDING_UPLOAD", "DELETED"],
  DELETED: [],
};

export interface LifecycleTransitionResult {
  status: AssetLifecycleStatus;
  changed: boolean;
}

export function transitionAssetStatus(
  current: AssetLifecycleStatus,
  next: AssetLifecycleStatus,
  options: { hasReferences?: boolean } = {},
): LifecycleTransitionResult {
  if (current === next) return { status: current, changed: false };
  if (next === "DELETED" && options.hasReferences) {
    throw new AssetApplicationError("ASSET_REFERENCED", "Referenced assets cannot be deleted.");
  }
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new AssetApplicationError("ASSET_INVALID_STATE", `Invalid asset transition: ${current} -> ${next}.`);
  }
  return { status: next, changed: true };
}

export function isUploadExpired(status: AssetLifecycleStatus, expiresAt: Date, now = new Date()): boolean {
  return status === "PENDING_UPLOAD" && expiresAt.getTime() <= now.getTime();
}
