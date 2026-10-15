import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import { config as loadEnvironment } from "dotenv";
import sharp from "sharp";

import { hashPassword } from "@archrender/auth";
import { AssetRepository, createDatabaseClient } from "@archrender/database";

import { AssetMaintenanceService } from "../src/asset-maintenance-service.js";
import { loadAssetStorageConfig } from "../src/config.js";
import { StorageError } from "../src/errors.js";
import { createAssetObjectKey, createThumbnailObjectKey } from "../src/object-key.js";
import { createR2StorageProvider } from "../src/r2-storage-provider.js";
import type { StorageObjectKey } from "../src/types.js";
import { createImmutableAcceptanceFixtures } from "./immutable-acceptance-fixtures.js";
import {
  formatSafeConcurrentOutcome,
  settleConcurrentHttpRequests,
} from "./concurrent-http.js";
import {
  readRecoveryManifest,
  removeRecoveryManifestIfResolved,
  runAfterRecoveryIdentityPersisted,
  writeDurableAtomicManifest,
  type RecoveryManifest,
  type RecoveryObject as TrackedObject,
} from "./recovery-manifest.js";

loadEnvironment({ path: new URL("../../database/.env", import.meta.url), quiet: true });
loadEnvironment({ path: new URL("../../../apps/web/.env.local", import.meta.url), quiet: true });

const execute = process.argv.includes("--execute");
const sequentialProbe = process.argv.includes("--probe");
const remainingAcceptance = process.argv.includes("--remaining");
const recoverIndex = process.argv.indexOf("--recover");
const recoveryPath = recoverIndex >= 0 ? process.argv[recoverIndex + 1] : undefined;
const baseUrl = process.env["R2_ACCEPTANCE_BASE_URL"] ?? "http://localhost:3000";
const config = loadAssetStorageConfig();
const database = createDatabaseClient();
const storage = createR2StorageProvider(config);

type JsonRecord = Record<string, unknown>;

const requestCounts = { put: 0, get: 0, head: 0, delete: 0, options: 0 };
const cleanupCounts = { objectsDeleted: 0, storageRowsDeleted: 0, assetsDeleted: 0, projectsDeleted: 0, sessionsDeleted: 0, usersDeleted: 0 };
const manifest: RecoveryManifest = {
  version: 1,
  runId: `m2dd2-r2-${Date.now()}-${randomUUID()}`,
  userIds: [],
  projectIds: [],
  assetIds: [],
  uploadRequestIds: [],
  objects: [],
};
const manifestDirectory = new URL("../.r2-acceptance/", import.meta.url);
const manifestUrl = new URL(`${manifest.runId}.json`, manifestDirectory);

class IntegrityStopError extends Error {}

function report(name: string, status: "PASS" | "FAIL" | "PLANNED", detail?: string) {
  process.stdout.write(`${name}=${status}${detail ? `:${detail}` : ""}\n`);
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeErrorCode(error: unknown) {
  if (error instanceof StorageError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z0-9_]{1,32}$/.test(code)) return code;
  }
  return "UNCLASSIFIED";
}

async function saveManifest() {
  await writeDurableAtomicManifest(manifestUrl, manifest);
}

async function statusOnlyPreflight() {
  const endpoint = new URL(config.endpoint);
  const appUrl = new URL(baseUrl);
  if (
    config.bucket !== "renderai" ||
    config.environment !== "development" ||
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(".r2.cloudflarestorage.com") ||
    !["localhost", "127.0.0.1"].includes(appUrl.hostname)
  ) {
    throw new Error("STATUS_PREFLIGHT_FAILED");
  }
  const migration = await database.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "_prisma_migrations"
    WHERE migration_name = '20261015000100_phase_2d_d_immutable_asset_storage'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  `;
  const legacy = await database.asset.count({
    where: { status: "READY", storageLayout: "LEGACY_SINGLE_OBJECT", integrityStatus: "LEGACY_GUARDED" },
  });
  if (migration[0]?.count !== 1n) throw new Error("MIGRATION_NOT_READY");
  const outstanding = await readdir(manifestDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (outstanding.some((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
    throw new Error("RECOVERY_OBLIGATION_OUTSTANDING");
  }
  report("ENVIRONMENT_STATUS", "PASS");
  report("BUCKET_RENDERAI", "PASS");
  report("IMMUTABLE_MIGRATION", "PASS");
  report("EXISTING_LEGACY_READY_COUNT", "PASS", String(legacy));
  report("RECOVERY_OBLIGATIONS", "PASS", "0");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("LOCAL_SERVER_NOT_READY");
}

async function assertLocalServerContract() {
  await waitForServer();
  const response = await fetch(`${baseUrl}/api/assets/${randomUUID()}/thumbnail?variant=grid`, {
    headers: { Cookie: "archrender_session=acceptance-contract-probe" },
    redirect: "manual",
  });
  if (
    response.status !== 401 ||
    response.headers.get("x-archrender-storage-contract") !== "2d-d-final-v1"
  ) {
    throw new Error("LOCAL_SERVER_STALE_BUILD");
  }
  report("LOCAL_SERVER_CONTRACT", "PASS", "2D_D_FINAL_V1");
}

async function apiJson(
  path: string,
  options: { method?: string; cookie?: string; body?: unknown; requestId?: string; signal?: AbortSignal } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Origin: baseUrl,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.requestId ? { "X-Request-Id": options.requestId } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
    redirect: "manual",
  });
  let body: JsonRecord = {};
  try { body = await response.json() as JsonRecord; } catch {}
  return { response, body };
}

async function login(email: string, password: string) {
  const { response } = await apiJson("/api/auth/login", {
    method: "POST",
    body: { email, password, returnTo: "/" },
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (response.status !== 200 || !cookie) throw new Error("TEST_LOGIN_FAILED");
  return cookie;
}

async function initiate(cookie: string, projectId: string, bytes: Uint8Array, name: string) {
  const requestId = randomUUID();
  manifest.uploadRequestIds.push(requestId);
  const { response, body } = await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.userIds.length > 0 && current.projectIds.includes(projectId) && current.uploadRequestIds.includes(requestId),
    mutation: () => apiJson("/api/assets/uploads", {
      method: "POST",
      cookie,
      body: {
        requestId,
        projectId,
        assetType: "SOURCE_IMAGE",
        originalName: name,
        contentType: "image/png",
        byteSize: bytes.byteLength,
      },
    }),
  });
  if (response.status !== 201) throw new Error("INITIATE_FAILED");
  const result = body["result"] as JsonRecord;
  const upload = result["upload"] as JsonRecord;
  const assetId = String(result["assetId"]);
  manifest.assetIds.push(assetId);
  await trackRows(assetId, null);
  await saveManifest();
  return {
    assetId,
    url: String(upload["url"]),
    headers: upload["requiredHeaders"] as Record<string, string>,
  };
}

async function storageRows(assetId: string) {
  return database.assetStorageObject.findMany({ where: { assetId }, orderBy: { role: "asc" } });
}

async function trackRows(assetId: string, checksum: string | null) {
  const asset = await database.asset.findUniqueOrThrow({ where: { id: assetId } });
  for (const row of await storageRows(assetId)) {
    const tracked = manifest.objects.find((object) => object.key === row.objectKey);
    if (!tracked) {
      manifest.objects.push({
        assetId,
        ownerId: row.ownerId,
        projectId: asset.projectId!,
        role: row.role,
        key: row.objectKey,
        checksumSha256: row.checksumSha256 ?? (row.role === "STAGING" ? checksum : null),
      });
    } else if (!tracked.checksumSha256 && row.checksumSha256) {
      tracked.checksumSha256 = row.checksumSha256;
    }
  }
  await saveManifest();
}

async function browserPut(contract: Awaited<ReturnType<typeof initiate>>, bytes: Uint8Array) {
  const tracked = manifest.objects.find(
    (object) => object.assetId === contract.assetId && object.role === "STAGING",
  );
  if (!tracked) throw new IntegrityStopError("STAGING_IDENTITY_MISSING");
  tracked.checksumSha256 = sha256(bytes);
  const response = await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.objects.some((object) => object.key === tracked.key && object.checksumSha256 === tracked.checksumSha256),
    mutation: async () => {
      requestCounts.put += 1;
      const headers = Object.fromEntries(
        Object.entries(contract.headers).filter(([name]) => name.toLowerCase() !== "content-length"),
      );
      return fetch(contract.url, { method: "PUT", headers, body: bytes as BodyInit });
    },
  });
  if (!response.ok) throw new Error("STAGING_PUT_FAILED");
  return response.headers.get("etag");
}

async function corsPreflight(url: string) {
  const requestedHeaders = "content-type,x-amz-meta-assetid";
  requestCounts.options += 1;
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": requestedHeaders,
    },
  });
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  const allowedMethods = response.headers.get("access-control-allow-methods")?.toUpperCase() ?? "";
  const allowedHeaders = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
  if (
    !response.ok ||
    !["*", "http://localhost:3000"].includes(allowedOrigin ?? "") ||
    !allowedMethods.split(",").map((value) => value.trim()).includes("PUT") ||
    requestedHeaders.split(",").some((header) => !allowedHeaders.split(",").map((value) => value.trim()).includes(header))
  ) {
    throw new Error("CORS_PREFLIGHT_FAILED");
  }
}

async function complete(cookie: string, assetId: string, requestId?: string) {
  return runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.assetIds.includes(assetId) && current.objects.some((object) => object.assetId === assetId),
    mutation: () => apiJson(`/api/assets/${assetId}/complete`, {
      method: "POST",
      cookie,
      body: {},
      ...(requestId ? { requestId } : {}),
    }),
  });
}

async function completeWithoutManifestWrite(cookie: string, assetId: string, signal: AbortSignal) {
  const result = await apiJson(`/api/assets/${assetId}/complete`, {
    method: "POST",
    cookie,
    body: {},
    signal,
  });
  return { status: result.response.status, code: result.body["code"] };
}

async function signedRead(cookie: string, assetId: string, expectedChecksum: string) {
  const contract = await apiJson(`/api/assets/${assetId}/read-url`, { cookie });
  if (contract.response.status !== 200) throw new Error("SIGNED_READ_DENIED");
  const url = String((contract.body["result"] as JsonRecord)["url"]);
  requestCounts.head += 1;
  requestCounts.get += 1;
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualChecksum = sha256(bytes);
  if (!response.ok || actualChecksum !== expectedChecksum) throw new IntegrityStopError("SIGNED_READ_MISMATCH");
  return actualChecksum;
}

async function thumbnailRead(
  cookie: string,
  ownerId: string,
  projectId: string,
  assetId: string,
  variant: "grid" | "detail",
) {
  const role = variant === "grid" ? "THUMBNAIL_GRID" : "THUMBNAIL_DETAIL";
  const randomId = createHash("sha256").update(`${assetId}:${variant}:v1`).digest("hex").slice(0, 32);
  const expectedKey = createThumbnailObjectKey({
    environment: "development",
    ownerId,
    projectId,
    assetId,
    randomId,
  }, variant);
  if (!manifest.objects.some((object) => object.key === expectedKey)) {
    manifest.objects.push({ assetId, ownerId, projectId, role, key: expectedKey, checksumSha256: null });
  }
  const contract = await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.objects.some((object) =>
      object.key === expectedKey && object.assetId === assetId && object.role === role
    ),
    mutation: () => apiJson(`/api/assets/${assetId}/thumbnail?variant=${variant}`, { cookie }),
  });
  if (contract.response.status !== 200) throw new Error("THUMBNAIL_CREATE_FAILED");
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 3;
  const row = await database.assetStorageObject.findUniqueOrThrow({
    where: { assetId_role: { assetId, role } },
  });
  if (
    row.state !== "VERIFIED" || row.objectKey !== expectedKey || !row.checksumSha256 ||
    !row.width || !row.height || row.contentType !== "image/webp"
  ) {
    throw new IntegrityStopError("THUMBNAIL_DATABASE_IDENTITY_MISMATCH");
  }
  manifest.objects.find((object) => object.key === expectedKey)!.checksumSha256 = row.checksumSha256;
  await saveManifest();
  const url = String((contract.body["result"] as JsonRecord)["url"]);
  requestCounts.get += 1;
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || sha256(bytes) !== row.checksumSha256) {
    throw new IntegrityStopError("THUMBNAIL_SIGNED_READ_MISMATCH");
  }
  const metadata = await sharp(bytes, { limitInputPixels: config.maxDecodedPixels, failOn: "error" }).metadata();
  const maximum = variant === "grid" ? { width: 480, height: 330 } : { width: 1280, height: 960 };
  if (
    metadata.format !== "webp" || !metadata.width || !metadata.height ||
    metadata.width > maximum.width || metadata.height > maximum.height
  ) {
    throw new IntegrityStopError("THUMBNAIL_FORMAT_OR_DIMENSIONS_INVALID");
  }
  return { checksumSha256: row.checksumSha256, width: metadata.width, height: metadata.height };
}

function assertTrackedObject(object: TrackedObject) {
  if (!manifest.userIds.includes(object.ownerId) || !manifest.projectIds.includes(object.projectId) ||
      !manifest.assetIds.includes(object.assetId) || config.bucket !== "renderai") {
    throw new Error("CLEANUP_OWNERSHIP_GUARD");
  }
  const prefix = `development/owners/${object.ownerId}/projects/${object.projectId}/assets/${object.assetId}/`;
  const suffix = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : "";
  const valid = object.role === "LEGACY" ? /^[a-f0-9]{32}$/i.test(suffix)
    : object.role === "STAGING" ? /^staging\/[a-f0-9]{32}$/i.test(suffix)
      : object.role === "ORIGINAL" ? /^original\/[a-f0-9]{32}$/i.test(suffix)
        : object.role === "THUMBNAIL_GRID" ? /^derivatives\/grid\/[a-f0-9]{32}$/i.test(suffix)
          : /^derivatives\/detail\/[a-f0-9]{32}$/i.test(suffix);
  if (!valid) throw new Error("CLEANUP_KEY_GUARD");
}

async function cleanupExact(target: RecoveryManifest, recoveryManifestPath: string | URL = manifestUrl) {
  const recoverableAssets = await database.asset.findMany({
    where: {
      ownerId: { in: target.userIds },
      uploadRequestId: { in: target.uploadRequestIds },
    },
    include: { storageObjects: true },
  });
  let manifestExpanded = false;
  for (const asset of recoverableAssets) {
    if (!target.assetIds.includes(asset.id)) {
      target.assetIds.push(asset.id);
      manifestExpanded = true;
    }
    for (const row of asset.storageObjects) {
      const tracked = target.objects.find((object) => object.key === row.objectKey);
      if (!tracked) {
        target.objects.push({
          assetId: asset.id,
          ownerId: row.ownerId,
          projectId: asset.projectId!,
          role: row.role,
          key: row.objectKey,
          checksumSha256: row.checksumSha256,
        });
        manifestExpanded = true;
      } else if (!tracked.checksumSha256 && row.checksumSha256) {
        tracked.checksumSha256 = row.checksumSha256;
        manifestExpanded = true;
      }
    }
  }
  if (manifestExpanded) await writeDurableAtomicManifest(recoveryManifestPath, target);
  for (const object of target.objects) {
    assertTrackedObject(object);
    requestCounts.head += 1;
    const exists = await storage.objectExists(object.key as StorageObjectKey);
    if (exists) {
      if (!object.checksumSha256) throw new Error("CLEANUP_CHECKSUM_UNAVAILABLE");
      requestCounts.get += 1;
      const stored = await storage.readObject(object.key as StorageObjectKey, config.maxUploadBytes);
      if (sha256(stored.bytes) !== object.checksumSha256) throw new IntegrityStopError("CLEANUP_CHECKSUM_GUARD");
    }
    requestCounts.delete += 1;
    await storage.deleteObject(object.key as StorageObjectKey);
    if (exists) cleanupCounts.objectsDeleted += 1;
    requestCounts.head += 1;
    if (await storage.objectExists(object.key as StorageObjectKey)) throw new Error("CLEANUP_DELETE_FAILED");
  }
  await database.$transaction(async (transaction) => {
    await transaction.activityLog.deleteMany({ where: { ownerId: { in: target.userIds } } });
    const derivatives = await transaction.assetStorageObject.deleteMany({
      where: { assetId: { in: target.assetIds }, sourceObjectId: { not: null } },
    });
    const storageRows = await transaction.assetStorageObject.deleteMany({ where: { assetId: { in: target.assetIds } } });
    const assets = await transaction.asset.deleteMany({ where: { id: { in: target.assetIds }, ownerId: { in: target.userIds } } });
    const projects = await transaction.project.deleteMany({ where: { id: { in: target.projectIds }, ownerId: { in: target.userIds } } });
    const sessions = await transaction.session.deleteMany({ where: { userId: { in: target.userIds } } });
    await transaction.loginAttempt.deleteMany({ where: { userId: { in: target.userIds } } });
    const users = await transaction.user.deleteMany({ where: { id: { in: target.userIds } } });
    cleanupCounts.storageRowsDeleted += derivatives.count + storageRows.count;
    cleanupCounts.assetsDeleted += assets.count;
    cleanupCounts.projectsDeleted += projects.count;
    cleanupCounts.sessionsDeleted += sessions.count;
    cleanupCounts.usersDeleted += users.count;
  });
  const [usersRemaining, projectsRemaining, assetsRemaining, storageRowsRemaining] = await Promise.all([
    database.user.count({ where: { id: { in: target.userIds } } }),
    database.project.count({ where: { id: { in: target.projectIds } } }),
    database.asset.count({ where: { id: { in: target.assetIds } } }),
    database.assetStorageObject.count({ where: { assetId: { in: target.assetIds } } }),
  ]);
  if (usersRemaining + projectsRemaining + assetsRemaining + storageRowsRemaining !== 0) {
    throw new IntegrityStopError("DATABASE_CLEANUP_INCOMPLETE");
  }
}

function safeProbeHeader(response: Response, name: string, allowed: RegExp) {
  const value = response.headers.get(name) ?? "NONE";
  return allowed.test(value) ? value : "INVALID";
}

async function executeSequentialProbe(fixtures: Awaited<ReturnType<typeof createImmutableAcceptanceFixtures>>) {
  const fixture = fixtures.main;
  const fixtureChecksum = fixtures.mainChecksum;
  const password = `R2 sequential probe ${randomBytes(24).toString("hex")}`;
  const userId = randomUUID();
  const projectId = randomUUID();
  manifest.userIds.push(userId);
  manifest.projectIds.push(projectId);
  await saveManifest();
  const [userCollision, projectCollision] = await Promise.all([
    database.user.count({ where: { id: userId } }),
    database.project.count({ where: { id: projectId } }),
  ]);
  if (userCollision !== 0 || projectCollision !== 0) throw new IntegrityStopError("FIXTURE_ID_COLLISION");
  const user = await database.user.create({
    data: {
      id: userId,
      email: `${manifest.runId}-probe@integration.invalid`,
      passwordHash: await hashPassword(password),
      role: "OWNER",
    },
  });
  const project = await database.project.create({
    data: { id: projectId, ownerId: user.id, name: `R2 Probe ${manifest.runId}`, slug: manifest.runId, type: "MIXED" },
  });
  const cookie = await login(user.email, password);
  const upload = await initiate(cookie, project.id, fixture, "immutable-sequential-probe.png");
  const rows = await storageRows(upload.assetId);
  const staging = rows.find((row) => row.role === "STAGING");
  const original = rows.find((row) => row.role === "ORIGINAL");
  if (!staging || !original || rows.length !== 2) throw new IntegrityStopError("PROBE_STORAGE_IDENTITY_INVALID");
  await browserPut(upload, fixture);
  const trackedFinal = manifest.objects.find((object) => object.key === original.objectKey);
  if (!trackedFinal) throw new IntegrityStopError("PROBE_FINAL_IDENTITY_MISSING");
  trackedFinal.checksumSha256 = fixtureChecksum;
  await saveManifest();

  const correlationId = randomUUID();
  const completion = await complete(cookie, upload.assetId, correlationId);
  report("PROBE_CORRELATION_ID", "PASS", correlationId);
  report("PROBE_COMPLETION_HTTP", completion.response.status === 200 ? "PASS" : "FAIL", String(completion.response.status));
  if (completion.response.status !== 200) {
    const phase = safeProbeHeader(completion.response, "x-archrender-finalization-phase", /^(claim|conditional_staging_read|verify|final_put|final_readback|commit)$/);
    const operation = safeProbeHeader(completion.response, "x-archrender-storage-operation", /^(NONE|headObject|readObject|createImmutableObject)$/);
    const storageCode = safeProbeHeader(completion.response, "x-archrender-storage-code", /^(NONE|NOT_FOUND|ACCESS_DENIED|INVALID_RESPONSE|TIMEOUT|THROTTLED|PRECONDITION_FAILED|UNAVAILABLE)$/);
    const providerStatus = safeProbeHeader(completion.response, "x-archrender-provider-status", /^(NONE|[1-5][0-9]{2})$/);
    const applicationStatus = safeProbeHeader(completion.response, "x-archrender-application-status", /^[1-5][0-9]{2}$/);
    if (["conditional_staging_read", "verify", "final_put", "final_readback", "commit"].includes(phase)) {
      requestCounts.head += 1;
    }
    if (
      ["verify", "final_put", "final_readback", "commit"].includes(phase) ||
      (phase === "conditional_staging_read" && operation === "readObject")
    ) {
      requestCounts.get += 1;
    }
    if (["final_put", "final_readback", "commit"].includes(phase)) requestCounts.put += 1;
    if (["final_readback", "commit"].includes(phase)) requestCounts.head += 1;
    if (phase === "final_readback" && operation === "readObject" || phase === "commit") requestCounts.get += 1;
    report("PROBE_FAILING_PHASE", "FAIL", phase);
    report("PROBE_STORAGE_OPERATION", "FAIL", operation);
    report("PROBE_STORAGE_CODE", "FAIL", storageCode);
    report("PROBE_PROVIDER_HTTP_STATUS", "FAIL", providerStatus);
    report("PROBE_APPLICATION_HTTP_STATUS", "FAIL", applicationStatus);
    throw new Error("SEQUENTIAL_DIAGNOSTIC_PROBE_FAILED");
  }
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 2;
  const ready = await database.asset.findUniqueOrThrow({ where: { id: upload.assetId } });
  if (
    ready.status !== "READY" || ready.integrityStatus !== "VERIFIED_IMMUTABLE" ||
    ready.checksumSha256 !== fixtureChecksum
  ) {
    throw new IntegrityStopError("PROBE_DATABASE_STATE_MISMATCH");
  }
  requestCounts.head += 1;
  const finalHead = await storage.headObject(original.objectKey as StorageObjectKey);
  requestCounts.get += 1;
  const finalBytes = await storage.readObject(original.objectKey as StorageObjectKey, config.maxUploadBytes, {
    ...(finalHead.etag ? { ifMatch: finalHead.etag } : {}),
  });
  if (sha256(finalBytes.bytes) !== fixtureChecksum) throw new IntegrityStopError("PROBE_FINAL_CHECKSUM_MISMATCH");
  report("PROBE_READY_VERIFIED_IMMUTABLE", "PASS");
  report("PROBE_FINAL_SHA256", "PASS");
}

async function executeAcceptance(fixtures: Awaited<ReturnType<typeof createImmutableAcceptanceFixtures>>) {
  await waitForServer();
  const passwordA = `R2 immutable acceptance ${randomBytes(24).toString("hex")}`;
  const passwordB = `R2 immutable acceptance ${randomBytes(24).toString("hex")}`;
  const userAId = randomUUID();
  const userBId = randomUUID();
  const projectId = randomUUID();
  manifest.userIds.push(userAId, userBId);
  manifest.projectIds.push(projectId);
  await saveManifest();
  const [userCollisions, projectCollisions] = await Promise.all([
    database.user.count({ where: { id: { in: manifest.userIds } } }),
    database.project.count({ where: { id: { in: manifest.projectIds } } }),
  ]);
  if (userCollisions !== 0 || projectCollisions !== 0) throw new IntegrityStopError("FIXTURE_ID_COLLISION");
  const [userA, userB] = await database.$transaction([
    database.user.create({ data: { id: userAId, email: `${manifest.runId}-a@integration.invalid`, passwordHash: await hashPassword(passwordA), role: "OWNER" } }),
    database.user.create({ data: { id: userBId, email: `${manifest.runId}-b@integration.invalid`, passwordHash: await hashPassword(passwordB), role: "OWNER" } }),
  ]);
  const project = await database.project.create({ data: {
    id: projectId, ownerId: userA.id, name: `R2 Immutable ${manifest.runId}`, slug: manifest.runId, type: "MIXED",
  } });
  await saveManifest();
  const [cookieA, cookieB] = await Promise.all([login(userA.email, passwordA), login(userB.email, passwordB)]);

  const fixture = fixtures.main;
  const alternate = fixtures.replay;
  const fixtureChecksum = fixtures.mainChecksum;

  const sequential = await initiate(cookieA, project.id, fixture, "immutable-sequential.png");
  await corsPreflight(sequential.url);
  const signedPath = decodeURIComponent(new URL(sequential.url).pathname);
  await trackRows(sequential.assetId, null);
  const sequentialRows = await storageRows(sequential.assetId);
  const staging = sequentialRows.find((row) => row.role === "STAGING")!;
  const original = sequentialRows.find((row) => row.role === "ORIGINAL")!;
  if (!signedPath.includes(staging.objectKey) || signedPath.includes(original.objectKey)) {
    throw new Error("FINAL_KEY_PRESIGNED_PUT_EXPOSED");
  }
  await browserPut(sequential, fixture);
  requestCounts.head += 1;
  const stagingHead = await storage.headObject(staging.objectKey as StorageObjectKey);
  const stagingIfMatch = stagingHead.etag?.trim();
  if (!stagingIfMatch) throw new Error("STAGING_ETAG_MISSING");
  requestCounts.get += 1;
  const conditional = await storage.readObject(staging.objectKey as StorageObjectKey, config.maxUploadBytes, {
    ifMatch: stagingIfMatch,
  });
  if (sha256(conditional.bytes) !== fixtureChecksum) throw new IntegrityStopError("CONDITIONAL_STAGING_GET_FAILED");
  report("STAGING_PRESIGNED_PUT_AND_CONDITIONAL_GET", "PASS");

  const trackedOriginal = manifest.objects.find((object) => object.key === original.objectKey);
  if (!trackedOriginal) throw new IntegrityStopError("FINAL_IDENTITY_MISSING");
  trackedOriginal.checksumSha256 = fixtureChecksum;
  await saveManifest();
  const finalized = await complete(cookieA, sequential.assetId);
  if (finalized.response.status !== 200) throw new Error("SEQUENTIAL_FINALIZE_FAILED");
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 2;
  const retry = await complete(cookieA, sequential.assetId);
  if (retry.response.status !== 200) throw new Error("FINALIZE_RETRY_FAILED");
  const ready = await database.asset.findUniqueOrThrow({ where: { id: sequential.assetId } });
  if (ready.status !== "READY" || ready.integrityStatus !== "VERIFIED_IMMUTABLE" || ready.checksumSha256 !== fixtureChecksum) {
    throw new Error("READY_IMMUTABLE_DB_MISMATCH");
  }
  report("READY_VERIFIED_IMMUTABLE", "PASS");
  const finalRow = await database.assetStorageObject.findFirstOrThrow({ where: { assetId: ready.id, role: "ORIGINAL" } });
  const finalShaBeforeReplay = await signedRead(cookieA, ready.id, fixtureChecksum);
  report("SEQUENTIAL_FINALIZE_AND_RETRY", "PASS");

  await browserPut(sequential, alternate);
  try {
    requestCounts.get += 1;
    await storage.readObject(staging.objectKey as StorageObjectKey, config.maxUploadBytes, { ifMatch: stagingIfMatch });
    throw new IntegrityStopError("STALE_ETAG_ACCEPTED");
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "PRECONDITION_FAILED")) throw error;
  }
  const finalShaAfterReplay = await signedRead(cookieA, ready.id, fixtureChecksum);
  report("STAGING_REPLAY_FINAL_CHECKSUM_INVARIANT", "PASS");
  try {
    await runAfterRecoveryIdentityPersisted({
      path: manifestUrl,
      manifest,
      hasRecoveryIdentity: (current) => current.objects.some((object) => object.key === finalRow.objectKey && object.assetId === ready.id),
      mutation: async () => {
        requestCounts.put += 1;
        return storage.createImmutableObject({
          key: finalRow.objectKey as StorageObjectKey,
          bytes: alternate,
          contentType: "image/png",
          metadata: { assetId: ready.id, role: "original", sha256: sha256(alternate) },
        });
      },
    });
    throw new IntegrityStopError("FINAL_OVERWRITE_ACCEPTED");
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "PRECONDITION_FAILED")) throw error;
  }
  await signedRead(cookieA, ready.id, fixtureChecksum);
  report("FINAL_IF_NONE_MATCH_AND_CONTENT_MD5", "PASS");

  const quotaBeforeDerivatives = await new AssetRepository(database).reservedBytes(userA.id);
  const grid = await thumbnailRead(cookieA, userA.id, project.id, ready.id, "grid");
  const detail = await thumbnailRead(cookieA, userA.id, project.id, ready.id, "detail");
  const quotaAfterDerivatives = await new AssetRepository(database).reservedBytes(userA.id);
  if (quotaAfterDerivatives <= quotaBeforeDerivatives) throw new Error("THUMBNAIL_QUOTA_NOT_ACCOUNTED");
  const originalAfterThumbnails = await signedRead(cookieA, ready.id, fixtureChecksum);
  if (originalAfterThumbnails !== fixtureChecksum) throw new IntegrityStopError("THUMBNAIL_CHANGED_ORIGINAL");
  report("PRIVATE_THUMBNAILS", "PASS", `GRID_${grid.width}X${grid.height}_DETAIL_${detail.width}X${detail.height}`);
  report("THUMBNAIL_QUOTA_AND_ORIGINAL_INVARIANCE", "PASS");

  const concurrent = await initiate(cookieA, project.id, fixture, "immutable-concurrent.png");
  await browserPut(concurrent, fixture);
  const concurrentRows = await storageRows(concurrent.assetId);
  const concurrentFinal = concurrentRows.find((row) => row.role === "ORIGINAL")!;
  manifest.objects.find((object) => object.key === concurrentFinal.objectKey)!.checksumSha256 = fixtureChecksum;
  // The exact recovery identity is already durable. Do not race two redundant
  // Windows manifest replacements before the HTTP requests under test.
  await saveManifest();
  const concurrentResults = await settleConcurrentHttpRequests([
    (signal) => completeWithoutManifestWrite(cookieA, concurrent.assetId, signal),
    (signal) => completeWithoutManifestWrite(cookieA, concurrent.assetId, signal),
  ]);
  const outcomes = concurrentResults.map(formatSafeConcurrentOutcome);
  report("CONCURRENT_FINALIZE_OUTCOMES", "PASS", outcomes.join("_"));
  if (
    !concurrentResults.some((result) => result.kind === "HTTP" && result.status === 200) ||
    concurrentResults.some((result) => result.kind !== "HTTP" || ![200, 409].includes(result.status))
  ) {
    throw new Error("CONCURRENT_FINALIZE_FAILED");
  }
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 2;
  const concurrentRetry = await complete(cookieA, concurrent.assetId);
  if (concurrentRetry.response.status !== 200) throw new Error("CONCURRENT_FINALIZE_RETRY_FAILED");
  const concurrentReady = await database.asset.findUniqueOrThrow({ where: { id: concurrent.assetId } });
  if (
    concurrentReady.status !== "READY" || concurrentReady.integrityStatus !== "VERIFIED_IMMUTABLE" ||
    concurrentReady.checksumSha256 !== fixtureChecksum
  ) {
    throw new IntegrityStopError("CONCURRENT_FINAL_STATE_MISMATCH");
  }
  await signedRead(cookieA, concurrent.assetId, fixtureChecksum);
  report("CONCURRENT_FINALIZE_AND_IDEMPOTENT_RETRY", "PASS");

  const recovery = await initiate(cookieA, project.id, fixture, "immutable-recovery.png");
  await browserPut(recovery, fixture);
  const recoveryRows = await storageRows(recovery.assetId);
  const recoveryFinal = recoveryRows.find((row) => row.role === "ORIGINAL")!;
  manifest.objects.find((object) => object.key === recoveryFinal.objectKey)!.checksumSha256 = fixtureChecksum;
  await saveManifest();
  await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.objects.some((object) => object.key === recoveryFinal.objectKey && object.checksumSha256 === fixtureChecksum),
    mutation: async () => {
      requestCounts.put += 1;
      return storage.createImmutableObject({
        key: recoveryFinal.objectKey as StorageObjectKey,
        bytes: fixture,
        contentType: "image/png",
        metadata: { assetId: recovery.assetId, role: "original", sha256: fixtureChecksum },
      });
    },
  });
  const recovered = await complete(cookieA, recovery.assetId);
  if (recovered.response.status !== 200) throw new Error("POST_PUT_DB_RECOVERY_FAILED");
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 2;
  await signedRead(cookieA, recovery.assetId, fixtureChecksum);
  report("POST_PUT_DB_FAILURE_RECOVERY", "PASS");

  const invalidBytes = Buffer.alloc(fixture.byteLength, 0x5a);
  const invalid = await initiate(cookieA, project.id, fixture, "immutable-invalid.png");
  await browserPut(invalid, invalidBytes);
  const rejected = await complete(cookieA, invalid.assetId);
  if (rejected.response.status !== 422) throw new Error("INVALID_CONTENT_ACCEPTED");
  requestCounts.get += 1;
  requestCounts.head += 1;
  const maintenancePlan = await new AssetMaintenanceService(database, storage, config).run({ limit: 100 });
  if (maintenancePlan.deleted !== 0 || maintenancePlan.recovered !== 0 || maintenancePlan.plannedDeletes < 1) {
    throw new Error("MAINTENANCE_DRY_RUN_FAILED");
  }
  report("MAINTENANCE_DRY_RUN", "PASS", `PLANNED_${maintenancePlan.plannedDeletes}_RECOVERY_${maintenancePlan.plannedRecoveries}`);

  const legacyId = randomUUID();
  const legacyKey = createAssetObjectKey({ environment: "development", ownerId: userA.id, projectId: project.id, assetId: legacyId });
  manifest.assetIds.push(legacyId);
  manifest.objects.push({ assetId: legacyId, ownerId: userA.id, projectId: project.id, role: "LEGACY", key: legacyKey, checksumSha256: fixtureChecksum });
  await saveManifest();
  const legacyObject = await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.objects.some((object) => object.key === legacyKey && object.checksumSha256 === fixtureChecksum),
    mutation: async () => {
      requestCounts.put += 1;
      return storage.createImmutableObject({
        key: legacyKey,
        bytes: fixture,
        contentType: "image/png",
        metadata: { assetId: legacyId, role: "legacy", sha256: fixtureChecksum },
      });
    },
  });
  await database.asset.create({ data: {
    id: legacyId,
    ownerId: userA.id,
    projectId: project.id,
    type: "SOURCE_IMAGE",
    status: "READY",
    storageLayout: "LEGACY_SINGLE_OBJECT",
    integrityStatus: "LEGACY_GUARDED",
    bucket: config.bucket,
    objectKey: legacyKey,
    contentType: "image/png",
    byteSize: BigInt(fixture.byteLength),
    width: 32,
    height: 24,
    checksumSha256: fixtureChecksum,
    verifiedAt: new Date(),
    metadata: { storageEtag: legacyObject.etag?.replace(/^"|"$/g, "") },
  } });
  await saveManifest();
  await signedRead(cookieA, legacyId, fixtureChecksum);
  const legacyThumbnail = await apiJson(`/api/assets/${legacyId}/thumbnail?variant=grid`, { cookie: cookieA });
  if (legacyThumbnail.response.status !== 200) throw new Error("LEGACY_THUMBNAIL_FALLBACK_FAILED");
  requestCounts.head += 1;
  requestCounts.get += 1;
  const legacyFallbackUrl = String((legacyThumbnail.body["result"] as JsonRecord)["url"]);
  const legacyFallback = await fetch(legacyFallbackUrl);
  if (!legacyFallback.ok || sha256(new Uint8Array(await legacyFallback.arrayBuffer())) !== fixtureChecksum) {
    throw new IntegrityStopError("LEGACY_THUMBNAIL_FALLBACK_MISMATCH");
  }
  if (await database.assetStorageObject.count({ where: { assetId: legacyId } }) !== 0) {
    throw new IntegrityStopError("LEGACY_DERIVATIVE_UNEXPECTED");
  }
  report("LEGACY_GUARDED_READ", "PASS");

  const denied = await apiJson(`/api/assets/${ready.id}/read-url`, { cookie: cookieB });
  const unauthorized = await apiJson(`/api/assets/${ready.id}/read-url`);
  if (denied.response.status !== 404 || unauthorized.response.status !== 401) throw new Error("OWNER_ISOLATION_FAILED");
  report("OWNER_ISOLATION_AND_UNAUTHORIZED_READ", "PASS");
  const databaseStates = await database.asset.findMany({
    where: { id: { in: manifest.assetIds } },
    select: { status: true, storageLayout: true, integrityStatus: true },
  });
  const readyVerified = databaseStates.filter((asset) => asset.status === "READY" && asset.storageLayout === "STAGED_IMMUTABLE_V1" && asset.integrityStatus === "VERIFIED_IMMUTABLE").length;
  const rejectedFailed = databaseStates.filter((asset) => asset.status === "REJECTED" && asset.integrityStatus === "FAILED").length;
  const legacyGuarded = databaseStates.filter((asset) => asset.status === "READY" && asset.storageLayout === "LEGACY_SINGLE_OBJECT" && asset.integrityStatus === "LEGACY_GUARDED").length;
  if (readyVerified !== 3 || rejectedFailed !== 1 || legacyGuarded !== 1) throw new IntegrityStopError("DATABASE_STATE_MISMATCH");
  report("DATABASE_STATE", "PASS", "READY_VERIFIED_3_REJECTED_FAILED_1_LEGACY_GUARDED_1");
  report("FINAL_SHA256_BEFORE_REPLAY", "PASS", finalShaBeforeReplay);
  report("FINAL_SHA256_AFTER_REPLAY", "PASS", finalShaAfterReplay);
  report("REAL_R2_IMMUTABLE_ACCEPTANCE", "PASS");
}

async function executeRemainingAcceptance(fixtures: Awaited<ReturnType<typeof createImmutableAcceptanceFixtures>>) {
  await waitForServer();
  const password = `R2 remaining acceptance ${randomBytes(24).toString("hex")}`;
  const userId = randomUUID();
  const projectId = randomUUID();
  manifest.userIds.push(userId);
  manifest.projectIds.push(projectId);
  await saveManifest();
  const [userCollision, projectCollision] = await Promise.all([
    database.user.count({ where: { id: userId } }),
    database.project.count({ where: { id: projectId } }),
  ]);
  if (userCollision !== 0 || projectCollision !== 0) throw new IntegrityStopError("FIXTURE_ID_COLLISION");
  const user = await database.user.create({ data: {
    id: userId,
    email: `${manifest.runId}-remaining@integration.invalid`,
    passwordHash: await hashPassword(password),
    role: "OWNER",
  } });
  const project = await database.project.create({ data: {
    id: projectId,
    ownerId: user.id,
    name: `R2 Remaining ${manifest.runId}`,
    slug: manifest.runId,
    type: "MIXED",
  } });
  await saveManifest();
  const cookie = await login(user.email, password);
  const fixture = fixtures.main;
  const fixtureChecksum = fixtures.mainChecksum;

  const concurrent = await initiate(cookie, project.id, fixture, "remaining-concurrent.png");
  await browserPut(concurrent, fixture);
  const concurrentRows = await storageRows(concurrent.assetId);
  const concurrentFinal = concurrentRows.find((row) => row.role === "ORIGINAL");
  if (!concurrentFinal) throw new IntegrityStopError("FINAL_IDENTITY_MISSING");
  manifest.objects.find((object) => object.key === concurrentFinal.objectKey)!.checksumSha256 = fixtureChecksum;
  await saveManifest();
  const concurrentResults = await settleConcurrentHttpRequests([
    (signal) => completeWithoutManifestWrite(cookie, concurrent.assetId, signal),
    (signal) => completeWithoutManifestWrite(cookie, concurrent.assetId, signal),
  ]);
  report("REMAINING_CONCURRENT_OUTCOMES", "PASS", concurrentResults.map(formatSafeConcurrentOutcome).join("_"));
  if (
    !concurrentResults.some((result) => result.kind === "HTTP" && result.status === 200) ||
    concurrentResults.some((result) => result.kind !== "HTTP" || ![200, 409].includes(result.status))
  ) {
    throw new Error("CONCURRENT_FINALIZE_FAILED");
  }
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 2;
  const concurrentRetry = await complete(cookie, concurrent.assetId);
  if (concurrentRetry.response.status !== 200) throw new Error("CONCURRENT_FINALIZE_RETRY_FAILED");
  const concurrentReady = await database.asset.findUniqueOrThrow({ where: { id: concurrent.assetId } });
  if (
    concurrentReady.status !== "READY" || concurrentReady.integrityStatus !== "VERIFIED_IMMUTABLE" ||
    concurrentReady.checksumSha256 !== fixtureChecksum
  ) {
    throw new IntegrityStopError("CONCURRENT_FINAL_STATE_MISMATCH");
  }
  await signedRead(cookie, concurrent.assetId, fixtureChecksum);
  report("REMAINING_CONCURRENT_AND_RETRY", "PASS");

  const recovery = await initiate(cookie, project.id, fixture, "remaining-recovery.png");
  await browserPut(recovery, fixture);
  const recoveryRows = await storageRows(recovery.assetId);
  const recoveryFinal = recoveryRows.find((row) => row.role === "ORIGINAL");
  if (!recoveryFinal) throw new IntegrityStopError("RECOVERY_FINAL_IDENTITY_MISSING");
  manifest.objects.find((object) => object.key === recoveryFinal.objectKey)!.checksumSha256 = fixtureChecksum;
  await saveManifest();
  await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.objects.some((object) =>
      object.key === recoveryFinal.objectKey && object.checksumSha256 === fixtureChecksum),
    mutation: async () => {
      requestCounts.put += 1;
      return storage.createImmutableObject({
        key: recoveryFinal.objectKey as StorageObjectKey,
        bytes: fixture,
        contentType: "image/png",
        metadata: { assetId: recovery.assetId, role: "original", sha256: fixtureChecksum },
      });
    },
  });
  const recovered = await complete(cookie, recovery.assetId);
  if (recovered.response.status !== 200) throw new Error("POST_PUT_DB_RECOVERY_FAILED");
  requestCounts.put += 1;
  requestCounts.get += 2;
  requestCounts.head += 2;
  await signedRead(cookie, recovery.assetId, fixtureChecksum);
  report("REMAINING_CRASH_RECOVERY", "PASS");

  const legacyId = randomUUID();
  const legacyKey = createAssetObjectKey({
    environment: "development",
    ownerId: user.id,
    projectId: project.id,
    assetId: legacyId,
  });
  manifest.assetIds.push(legacyId);
  manifest.objects.push({
    assetId: legacyId,
    ownerId: user.id,
    projectId: project.id,
    role: "LEGACY",
    key: legacyKey,
    checksumSha256: fixtureChecksum,
  });
  await saveManifest();
  const legacyObject = await runAfterRecoveryIdentityPersisted({
    path: manifestUrl,
    manifest,
    hasRecoveryIdentity: (current) => current.objects.some((object) =>
      object.key === legacyKey && object.checksumSha256 === fixtureChecksum),
    mutation: async () => {
      requestCounts.put += 1;
      return storage.createImmutableObject({
        key: legacyKey,
        bytes: fixture,
        contentType: "image/png",
        metadata: { assetId: legacyId, role: "legacy", sha256: fixtureChecksum },
      });
    },
  });
  await database.asset.create({ data: {
    id: legacyId,
    ownerId: user.id,
    projectId: project.id,
    type: "SOURCE_IMAGE",
    status: "READY",
    storageLayout: "LEGACY_SINGLE_OBJECT",
    integrityStatus: "LEGACY_GUARDED",
    bucket: config.bucket,
    objectKey: legacyKey,
    contentType: "image/png",
    byteSize: BigInt(fixture.byteLength),
    width: 32,
    height: 24,
    checksumSha256: fixtureChecksum,
    verifiedAt: new Date(),
    metadata: { storageEtag: legacyObject.etag?.replace(/^"|"$/g, "") },
  } });
  await saveManifest();
  await signedRead(cookie, legacyId, fixtureChecksum);
  const fallback = await apiJson(`/api/assets/${legacyId}/thumbnail?variant=grid`, { cookie });
  if (fallback.response.status !== 200) throw new Error("LEGACY_THUMBNAIL_FALLBACK_FAILED");
  requestCounts.head += 1;
  requestCounts.get += 1;
  const fallbackUrl = String((fallback.body["result"] as JsonRecord)["url"]);
  const fallbackResponse = await fetch(fallbackUrl);
  if (!fallbackResponse.ok || sha256(new Uint8Array(await fallbackResponse.arrayBuffer())) !== fixtureChecksum) {
    throw new IntegrityStopError("LEGACY_THUMBNAIL_FALLBACK_MISMATCH");
  }
  if (await database.assetStorageObject.count({ where: { assetId: legacyId } }) !== 0) {
    throw new IntegrityStopError("LEGACY_DERIVATIVE_UNEXPECTED");
  }
  report("REMAINING_LEGACY_GUARDED", "PASS");

  const states = await database.asset.findMany({
    where: { id: { in: manifest.assetIds } },
    select: { status: true, storageLayout: true, integrityStatus: true },
  });
  const verified = states.filter((asset) =>
    asset.status === "READY" && asset.storageLayout === "STAGED_IMMUTABLE_V1" &&
    asset.integrityStatus === "VERIFIED_IMMUTABLE").length;
  const guarded = states.filter((asset) =>
    asset.status === "READY" && asset.storageLayout === "LEGACY_SINGLE_OBJECT" &&
    asset.integrityStatus === "LEGACY_GUARDED").length;
  if (verified !== 2 || guarded !== 1) throw new IntegrityStopError("REMAINING_DATABASE_STATE_MISMATCH");
  report("REMAINING_DATABASE_STATE", "PASS", "READY_VERIFIED_2_LEGACY_GUARDED_1");
  report("REMAINING_R2_ACCEPTANCE", "PASS");
}

async function main() {
  await statusOnlyPreflight();
  await assertLocalServerContract();
  if (!execute) {
    report("MODE", "PLANNED", "NO_R2_REQUESTS_NO_DATABASE_WRITES");
    if (sequentialProbe) {
      report("PROBE_OBJECTS_EXISTING_MAX", "PLANNED", "2");
      report("PROBE_RECOVERY_IDENTITIES_MAX", "PLANNED", "2");
      report("PROBE_PUT_REQUESTS_MAX", "PLANNED", "2");
      report("PROBE_GET_REQUESTS_MAX", "PLANNED", "5");
      report("PROBE_HEAD_REQUESTS_MAX", "PLANNED", "7");
      report("PROBE_DELETE_REQUESTS_MAX", "PLANNED", "2");
      report("PROBE_COPY_OPTIONS_REQUESTS", "PLANNED", "0");
      report("PROBE_SDK_MAX_ATTEMPTS", "PLANNED", "1");
      return;
    }
    if (remainingAcceptance) {
      report("REMAINING_OBJECTS_EXISTING_MAX", "PLANNED", "5");
      report("REMAINING_RECOVERY_IDENTITIES_MAX", "PLANNED", "5");
      report("REMAINING_PUT_REQUESTS_MAX", "PLANNED", "8");
      report("REMAINING_GET_REQUESTS_MAX", "PLANNED", "18");
      report("REMAINING_HEAD_REQUESTS_MAX", "PLANNED", "24");
      report("REMAINING_DELETE_REQUESTS_MAX", "PLANNED", "5");
      report("REMAINING_COPY_OPTIONS_REQUESTS", "PLANNED", "0");
      report("REMAINING_SDK_MAX_ATTEMPTS", "PLANNED", "1");
      return;
    }
    report("OBJECTS_EXISTING_MAX", "PLANNED", "10");
    report("RECOVERY_OBJECT_IDENTITIES_MAX", "PLANNED", "11");
    report("PUT_REQUESTS_MAX", "PLANNED", "15");
    report("GET_REQUESTS_MAX", "PLANNED", "36");
    report("HEAD_REQUESTS_MAX", "PLANNED", "48");
    report("DELETE_REQUESTS_MAX", "PLANNED", "11");
    report("CORS_OPTIONS", "PLANNED", "1");
    report("COPY_REQUESTS", "PLANNED", "0");
    report("PHYSICAL_ACCOUNTING", "PLANNED", "DIRECT_OBSERVED_SERVER_LOGICAL_ESTIMATE_SDK_MAX_ATTEMPTS_1");
    return;
  }
  if (recoveryPath) {
    const recoveredManifest = await readRecoveryManifest(recoveryPath);
    Object.assign(manifest, recoveredManifest);
    await cleanupExact(manifest, recoveryPath);
    await removeRecoveryManifestIfResolved(recoveryPath, { cleanupVerified: true });
    report("RECOVERY_CLEANUP", "PASS");
    return;
  }
  let preserveManifest = false;
  try {
    const fixtures = await createImmutableAcceptanceFixtures();
    if (sequentialProbe) {
      await executeSequentialProbe(fixtures);
    } else {
      requestCounts.head += 1;
      const missing = `development/acceptance-preflight/${randomUUID()}` as StorageObjectKey;
      if (await storage.objectExists(missing)) throw new Error("PREFLIGHT_KEY_COLLISION");
      if (remainingAcceptance) {
        await executeRemainingAcceptance(fixtures);
      } else {
        await executeAcceptance(fixtures);
      }
    }
  } catch (error) {
    preserveManifest = error instanceof IntegrityStopError;
    throw error;
  } finally {
    if (manifest.userIds.length > 0 && !preserveManifest) {
      await cleanupExact(manifest);
      await removeRecoveryManifestIfResolved(manifestUrl, { cleanupVerified: true });
    }
    const withinBudget = sequentialProbe
      ? requestCounts.put <= 2 && requestCounts.get <= 5 && requestCounts.head <= 7 &&
        requestCounts.delete <= 2 && requestCounts.options === 0
      : remainingAcceptance
        ? requestCounts.put <= 8 && requestCounts.get <= 18 && requestCounts.head <= 24 &&
          requestCounts.delete <= 5 && requestCounts.options === 0
        : requestCounts.put <= 15 && requestCounts.get <= 36 && requestCounts.head <= 48 &&
          requestCounts.delete <= 11 && requestCounts.options <= 1;
    report("OBSERVED_PLUS_SERVER_LOGICAL_COUNTS", withinBudget ? "PASS" : "FAIL", `PUT_${requestCounts.put}_GET_${requestCounts.get}_HEAD_${requestCounts.head}_DELETE_${requestCounts.delete}_OPTIONS_${requestCounts.options}`);
    if (!withinBudget) process.exitCode = 1;
    report("CLEANUP_COUNTS", preserveManifest ? "FAIL" : "PASS", `OBJECTS_${cleanupCounts.objectsDeleted}_STORAGE_ROWS_${cleanupCounts.storageRowsDeleted}_ASSETS_${cleanupCounts.assetsDeleted}_PROJECTS_${cleanupCounts.projectsDeleted}_SESSIONS_${cleanupCounts.sessionsDeleted}_USERS_${cleanupCounts.usersDeleted}`);
  }
}

main()
  .catch((error: unknown) => {
    report("REAL_R2_IMMUTABLE_ACCEPTANCE", "FAIL", safeErrorCode(error));
    process.exitCode = 1;
  })
  .finally(async () => database.$disconnect());
