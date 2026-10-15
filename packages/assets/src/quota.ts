import { AssetApplicationError } from "./errors";

export interface UploadQuotaSnapshot {
  recentInitiatedUploads: number;
  concurrentUploads: number;
  reservedBytes: bigint;
}

export interface UploadQuotaPolicy {
  initiateRatePerMinute: number;
  maxConcurrentUploads: number;
  ownerQuotaBytes: number;
}

export function assertUploadCapacity(
  snapshot: UploadQuotaSnapshot,
  requestedBytes: number,
  policy: UploadQuotaPolicy,
): void {
  if (snapshot.recentInitiatedUploads >= policy.initiateRatePerMinute) {
    throw new AssetApplicationError("ASSET_RATE_LIMITED", "Upload initiation rate exceeded.", true);
  }
  if (snapshot.concurrentUploads >= policy.maxConcurrentUploads) {
    throw new AssetApplicationError("ASSET_CONCURRENT_LIMIT", "Concurrent upload limit exceeded.", true);
  }
  if (snapshot.reservedBytes + BigInt(requestedBytes) > BigInt(policy.ownerQuotaBytes)) {
    throw new AssetApplicationError("ASSET_QUOTA_EXCEEDED", "Storage quota exceeded.");
  }
}
