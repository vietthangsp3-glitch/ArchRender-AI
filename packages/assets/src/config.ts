import { z } from "zod";

import type { StorageEnvironment } from "./types";

const integerFromEnvironment = (minimum: number, maximum: number, fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : Number(value)),
    z.number().int().min(minimum).max(maximum),
  );

const storageEnvironmentSchema = z.object({
  R2_ACCOUNT_ID: z.string().trim().min(1),
  R2_BUCKET_NAME: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  R2_ACCESS_KEY_ID: z.string().trim().min(1),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1),
  R2_ENDPOINT: z.string().url().optional(),
  ASSET_STORAGE_ENVIRONMENT: z.enum(["development", "staging", "production"]).default("development"),
  ASSET_MAX_UPLOAD_BYTES: integerFromEnvironment(1, 100 * 1024 * 1024, 25 * 1024 * 1024),
  ASSET_MAX_IMAGE_DIMENSION: integerFromEnvironment(64, 32_768, 16_384),
  ASSET_MAX_DECODED_PIXELS: integerFromEnvironment(4_096, 250_000_000, 100_000_000),
  ASSET_SIGNED_URL_TTL_SECONDS: integerFromEnvironment(30, 900, 300),
  ASSET_INITIATE_RATE_PER_MINUTE: integerFromEnvironment(1, 1_000, 20),
  ASSET_MAX_CONCURRENT_UPLOADS: integerFromEnvironment(1, 100, 8),
  ASSET_OWNER_QUOTA_BYTES: integerFromEnvironment(1, 10 * 1024 ** 4, 10 * 1024 ** 3),
  ASSET_VERIFICATION_STALE_SECONDS: integerFromEnvironment(60, 86_400, 600),
  ASSET_MAX_VERIFICATION_ATTEMPTS: integerFromEnvironment(1, 10, 3),
  ASSET_MAX_CONCURRENT_VERIFICATIONS: integerFromEnvironment(1, 16, 2),
});

export interface AssetStorageConfig {
  accountId: string;
  bucket: string;
  endpoint: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  environment: StorageEnvironment;
  maxUploadBytes: number;
  maxImageDimension: number;
  maxDecodedPixels: number;
  signedUrlTtlSeconds: number;
  initiateRatePerMinute: number;
  maxConcurrentUploads: number;
  ownerQuotaBytes: number;
  verificationStaleSeconds: number;
  maxVerificationAttempts: number;
  maxConcurrentVerifications: number;
}

export function loadAssetStorageConfig(environment: NodeJS.ProcessEnv = process.env): AssetStorageConfig {
  if (typeof window !== "undefined") throw new Error("Asset storage configuration is server-only.");
  const parsed = storageEnvironmentSchema.parse(environment);
  const endpoint = new URL(
    parsed.R2_ENDPOINT ?? `https://${parsed.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  );
  const expectedHost = `${parsed.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  if (endpoint.protocol !== "https:" || endpoint.hostname !== expectedHost) {
    throw new Error("R2 endpoint must use HTTPS and match the configured account.");
  }
  return {
    accountId: parsed.R2_ACCOUNT_ID,
    bucket: parsed.R2_BUCKET_NAME,
    endpoint: endpoint.origin,
    credentials: {
      accessKeyId: parsed.R2_ACCESS_KEY_ID,
      secretAccessKey: parsed.R2_SECRET_ACCESS_KEY,
    },
    environment: parsed.ASSET_STORAGE_ENVIRONMENT,
    maxUploadBytes: parsed.ASSET_MAX_UPLOAD_BYTES,
    maxImageDimension: parsed.ASSET_MAX_IMAGE_DIMENSION,
    maxDecodedPixels: parsed.ASSET_MAX_DECODED_PIXELS,
    signedUrlTtlSeconds: parsed.ASSET_SIGNED_URL_TTL_SECONDS,
    initiateRatePerMinute: parsed.ASSET_INITIATE_RATE_PER_MINUTE,
    maxConcurrentUploads: parsed.ASSET_MAX_CONCURRENT_UPLOADS,
    ownerQuotaBytes: parsed.ASSET_OWNER_QUOTA_BYTES,
    verificationStaleSeconds: parsed.ASSET_VERIFICATION_STALE_SECONDS,
    maxVerificationAttempts: parsed.ASSET_MAX_VERIFICATION_ATTEMPTS,
    maxConcurrentVerifications: parsed.ASSET_MAX_CONCURRENT_VERIFICATIONS,
  };
}
