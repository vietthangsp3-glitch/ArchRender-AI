import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import { S3Client } from "@aws-sdk/client-s3";
import { config as loadEnvironment } from "dotenv";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import sharp from "sharp";

import { loadAssetStorageConfig } from "../src/config.js";
import { StorageError } from "../src/errors.js";
import { createStagingObjectKey } from "../src/object-key.js";
import {
  createR2S3ClientConfig,
  R2StorageProvider,
} from "../src/r2-storage-provider.js";
import type { StorageObjectKey } from "../src/types.js";
import {
  readRecoveryManifest,
  removeRecoveryManifestIfResolved,
  runAfterRecoveryIdentityPersisted,
  writeDurableAtomicManifest,
  type RecoveryManifest,
} from "./recovery-manifest.js";
import {
  assertSerializedUploadContract,
  classifyR2DiagnosticBody,
} from "./r2-put403-diagnostic-support.js";

loadEnvironment({ path: new URL("../../../apps/web/.env.local", import.meta.url), quiet: true });

const execute = process.argv.includes("--execute");
const config = loadAssetStorageConfig();
const manifestDirectory = new URL("../.r2-put403-probe/", import.meta.url);
const runId = `m2dd2-r2-${Date.now()}-${randomUUID()}`;
const manifestUrl = new URL(`${runId}.json`, manifestDirectory);
const counts = { put: 0, get: 0, head: 0, delete: 0 };
let cleanupResolved = false;

function report(name: string, status: "PASS" | "FAIL" | "PLANNED", detail?: string) {
  process.stdout.write(`${name}=${status}${detail ? `:${detail}` : ""}\n`);
}

function safeErrorCode(error: unknown) {
  if (error instanceof StorageError) return `STORAGE_${error.code}`;
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
  return "UNCLASSIFIED";
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function statusOnlyPreflight() {
  const endpoint = new URL(config.endpoint);
  const environmentMatches = config.environment === "staging";
  const bucketMatches = config.bucket === "renderai";
  const endpointMatches = endpoint.protocol === "https:" && endpoint.hostname.endsWith(".r2.cloudflarestorage.com");
  const outstanding = await readdir(manifestDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const hasOutstandingRecovery = outstanding.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  report(
    "ASSET_STORAGE_ENVIRONMENT",
    environmentMatches ? "PASS" : "FAIL",
    `EXPECTED_STAGING_ACTUAL_${config.environment.toUpperCase()}`,
  );
  report(
    "R2_BUCKET_NAME",
    bucketMatches ? "PASS" : "FAIL",
    bucketMatches ? "EXPECTED_RENDERAI_ACTUAL_MATCH" : "EXPECTED_RENDERAI_ACTUAL_MISMATCH_REDACTED",
  );
  report(
    "R2_ENDPOINT_STRUCTURE",
    endpointMatches ? "PASS" : "FAIL",
    endpointMatches ? "EXPECTED_HTTPS_ACCOUNT_R2_HOST_ACTUAL_MATCH" : "EXPECTED_HTTPS_ACCOUNT_R2_HOST_ACTUAL_MISMATCH",
  );
  report("R2_CREDENTIAL_FIELDS", "PASS", "PRESENT_VALIDATED_NOT_DISPLAYED");
  report("RECOVERY_OBLIGATIONS", hasOutstandingRecovery ? "FAIL" : "PASS", hasOutstandingRecovery ? "NONZERO" : "0");
  if (!environmentMatches || !bucketMatches || !endpointMatches) {
    throw new Error("STAGING_STATUS_PREFLIGHT_FAILED");
  }
  if (hasOutstandingRecovery) {
    throw new Error("RECOVERY_OBLIGATION_OUTSTANDING");
  }
}

function assertExactIdentity(manifest: RecoveryManifest, key: StorageObjectKey) {
  const object = manifest.objects[0];
  const expectedPrefix = `staging/owners/${object?.ownerId}/projects/${object?.projectId}/assets/${object?.assetId}/staging/`;
  if (
    manifest.objects.length !== 1 || object?.key !== key ||
    !key.startsWith(expectedPrefix) || !/^[a-f0-9]{32}$/i.test(key.slice(expectedPrefix.length)) ||
    !object.checksumSha256
  ) {
    throw new Error("EXACT_IDENTITY_GUARD_FAILED");
  }
  return object;
}

async function cleanupExact(storage: R2StorageProvider, manifest: RecoveryManifest, key: StorageObjectKey) {
  const tracked = assertExactIdentity(manifest, key);
  counts.head += 1;
  if (await storage.objectExists(key)) {
    counts.get += 1;
    const stored = await storage.readObject(key, config.maxUploadBytes);
    if (sha256(stored.bytes) !== tracked.checksumSha256) throw new Error("CLEANUP_CHECKSUM_MISMATCH");
    counts.delete += 1;
    await storage.deleteObject(key);
  }
  counts.head += 1;
  if (await storage.objectExists(key)) throw new Error("CLEANUP_DELETE_FAILED");
  await removeRecoveryManifestIfResolved(manifestUrl, { cleanupVerified: true });
  cleanupResolved = true;
  report("EXACT_KEY_CLEANUP", "PASS");
  report("RECOVERY_OBLIGATIONS", "PASS", "0");
}

async function main() {
  await statusOnlyPreflight();
  report("MODE", execute ? "PASS" : "PLANNED", execute ? "ONE_BOUNDED_MUTATION_RUN" : "NO_R2_REQUESTS");
  report("OBJECTS_EXISTING_MAX", "PLANNED", "1");
  report("REQUEST_BUDGET", "PLANNED", "PUT_1_GET_2_HEAD_4_DELETE_1_COPY_OPTIONS_0");
  report("SDK_MAX_ATTEMPTS", "PLANNED", "1");
  if (!execute) return;

  const ownerId = randomUUID();
  const projectId = randomUUID();
  const assetId = randomUUID();
  const key = createStagingObjectKey({
    environment: "staging",
    ownerId,
    projectId,
    assetId,
    randomId: randomBytes(16).toString("hex"),
  });
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#234567" } })
    .jpeg({ quality: 80, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const checksum = sha256(bytes);
  const manifest: RecoveryManifest = {
    version: 1,
    runId,
    userIds: [ownerId],
    projectIds: [projectId],
    assetIds: [assetId],
    uploadRequestIds: [randomUUID()],
    objects: [{ assetId, ownerId, projectId, role: "STAGING", key, checksumSha256: checksum }],
  };
  await writeDurableAtomicManifest(manifestUrl, manifest);
  await readRecoveryManifest(manifestUrl);
  report("DURABLE_MANIFEST", "PASS");

  const client = new S3Client({
    ...createR2S3ClientConfig(config),
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 15_000 }),
  });
  const storage = new R2StorageProvider(client, config.bucket);
  counts.head += 1;
  if (await storage.objectExists(key)) throw new Error("SYNTHETIC_KEY_COLLISION");
  const contract = await storage.createPresignedUpload({
    key,
    contentType: "image/jpeg",
    contentLength: bytes.byteLength,
    metadata: { assetId },
    expiresInSeconds: Math.min(config.signedUrlTtlSeconds, 300),
  });
  assertSerializedUploadContract({
    url: contract.url,
    requiredHeaders: contract.requiredHeaders,
    contentType: "image/jpeg",
    contentLength: bytes.byteLength,
    assetId,
  });
  const signedHost = new URL(contract.url).hostname;
  const endpointHost = new URL(config.endpoint).hostname;
  if (signedHost !== endpointHost && signedHost !== `${config.bucket}.${endpointHost}`) {
    throw new Error("SIGNED_HOST_MISMATCH");
  }
  report("SIGNED_HEADER_VALUES", "PASS", "LENGTH_TYPE_HOST_METADATA_EXACT");

  const headers = Object.fromEntries(
    Object.entries(contract.requiredHeaders).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
  const response = await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (candidate) => candidate.objects[0]?.key === key && candidate.objects[0]?.checksumSha256 === checksum,
    mutation: async () => {
      counts.put += 1;
      return fetch(contract.url, {
        method: "PUT",
        headers: { ...headers, Origin: "https://arch-render-ai.vercel.app" },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(30_000),
      });
    },
  });
  report("PUT_HTTP_STATUS", response.ok ? "PASS" : "FAIL", String(response.status));
  if (!response.ok) {
    const safeProviderCode = classifyR2DiagnosticBody((await response.text()).slice(0, 4_096));
    report("R2_PROVIDER_CODE", "FAIL", safeProviderCode);
    await cleanupExact(storage, manifest, key);
    throw new Error("R2_PUT_DIAGNOSTIC_FAILED");
  }

  counts.head += 1;
  const metadata = await storage.headObject(key);
  if (
    metadata.contentLength !== bytes.byteLength || metadata.contentType !== "image/jpeg" ||
    metadata.metadata["assetid"] !== assetId
  ) {
    throw new Error("R2_OBJECT_METADATA_MISMATCH");
  }
  counts.get += 1;
  const stored = await storage.readObject(key, bytes.byteLength);
  if (sha256(stored.bytes) !== checksum) throw new Error("R2_OBJECT_CHECKSUM_MISMATCH");
  report("R2_OBJECT_INTEGRITY", "PASS");
  await cleanupExact(storage, manifest, key);
}

main().catch((error: unknown) => {
  report("R2_PUT403_DIAGNOSTIC", "FAIL", safeErrorCode(error));
  if (!cleanupResolved && execute) report("RECOVERY_OBLIGATIONS", "FAIL", "MANIFEST_RETAINED");
  process.exitCode = 1;
});
