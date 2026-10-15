import { createHash, randomBytes, randomUUID } from "node:crypto";

import { config as loadEnvironment } from "dotenv";
import sharp from "sharp";

import { hashPassword } from "@archrender/auth";
import { createDatabaseClient } from "@archrender/database";

import { loadAssetStorageConfig } from "../src/config.js";
import { StorageError } from "../src/errors.js";
import { createR2StorageProvider } from "../src/r2-storage-provider.js";
import type { StorageObjectKey } from "../src/types.js";

loadEnvironment({ path: new URL("../../database/.env", import.meta.url), quiet: true });
loadEnvironment({ path: new URL("../../../apps/web/.env.local", import.meta.url), quiet: true });

const baseUrl = process.env["R2_ACCEPTANCE_BASE_URL"] ?? "http://localhost:3101";
const runId = `m2db-r2-${Date.now()}-${randomUUID()}`;
const database = createDatabaseClient();
const config = loadAssetStorageConfig();
const storage = createR2StorageProvider(config);
const userIds: string[] = [];
const projectIds: string[] = [];
const assetIds = new Set<string>();
const createdObjectKeys = new Set<string>();
let deletedExistingObjects = 0;
let databaseRecordsDeleted = 0;

type JsonRecord = Record<string, unknown>;

function safeResult(name: string, status: "PASS" | "FAIL" | "OBSERVED", detail?: string) {
  console.log(`${name}=${status}${detail ? `:${detail}` : ""}`);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Local application server is not ready.");
}

async function apiJson(
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Origin: baseUrl,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
  let body: JsonRecord = {};
  try {
    body = await response.json() as JsonRecord;
  } catch {}
  return { response, body };
}

async function login(email: string, password: string): Promise<string> {
  const { response } = await apiJson("/api/auth/login", {
    method: "POST",
    body: { email, password, returnTo: "/" },
  });
  if (response.status !== 200) throw new Error(`Test account login failed (${response.status}).`);
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie) throw new Error("Test account session cookie was not issued.");
  return cookie;
}

async function initiate(cookie: string, projectId: string, bytes: number, name: string) {
  const { response, body } = await apiJson("/api/assets/uploads", {
    method: "POST",
    cookie,
    body: {
      requestId: randomUUID(),
      projectId,
      assetType: "SOURCE_IMAGE",
      originalName: name,
      contentType: "image/png",
      byteSize: bytes,
    },
  });
  if (response.status !== 201) {
    throw new Error(`Initiate failed (${response.status}, ${String(body["code"] ?? "UNKNOWN")}).`);
  }
  const result = body["result"] as JsonRecord;
  const upload = result["upload"] as JsonRecord;
  const assetId = String(result["assetId"]);
  assetIds.add(assetId);
  return {
    assetId,
    url: String(upload["url"]),
    requiredHeaders: upload["requiredHeaders"] as Record<string, string>,
  };
}

async function initiateRaw(
  cookie: string,
  projectId: string,
  bytes: number,
  name: string,
  contentType = "image/png",
) {
  return apiJson("/api/assets/uploads", {
    method: "POST",
    cookie,
    body: {
      requestId: randomUUID(),
      projectId,
      assetType: "SOURCE_IMAGE",
      originalName: name,
      contentType,
      byteSize: bytes,
    },
  });
}

function uploadHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
}

async function put(contract: Awaited<ReturnType<typeof initiate>>, bytes: Uint8Array) {
  const response = await fetch(contract.url, {
    method: "PUT",
    headers: uploadHeaders(contract.requiredHeaders),
    body: bytes as BodyInit,
  });
  if (response.ok) {
    const asset = await database.asset.findUniqueOrThrow({ where: { id: contract.assetId } });
    createdObjectKeys.add(asset.objectKey);
  }
  return response;
}

async function safeR2ErrorCode(response: Response): Promise<string> {
  if (response.ok) return "NONE";
  const body = await response.clone().text();
  const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(body)?.[1];
  return code && /^[A-Za-z0-9]{1,64}$/.test(code) ? code : "UNCLASSIFIED";
}

async function complete(cookie: string, assetId: string, body: JsonRecord = {}) {
  return apiJson(`/api/assets/${assetId}/complete`, { method: "POST", cookie, body });
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function corsPreflight(signedUrl: string) {
  const origin = "http://localhost:3000";
  const response = await fetch(signedUrl, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,x-amz-meta-assetid",
    },
  });
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  const methods = response.headers.get("access-control-allow-methods")?.toUpperCase() ?? "";
  const headers = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
  if (
    !response.ok || (allowedOrigin !== origin && allowedOrigin !== "*") ||
    !methods.includes("PUT") || !headers.includes("content-type") ||
    !headers.includes("x-amz-meta-assetid")
  ) throw new Error("R2 CORS preflight did not allow the signed upload contract.");
}

async function assertCredentialScope() {
  const missingKey = `development/acceptance-preflight/${randomUUID()}` as StorageObjectKey;
  try {
    await storage.headObject(missingKey);
    throw new Error("Unexpected preflight object exists.");
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "NOT_FOUND")) throw error;
  }
}

async function cleanup() {
  const assets = await database.asset.findMany({ where: { id: { in: [...assetIds] } } });
  for (const asset of assets) {
    if (!userIds.includes(asset.ownerId) || !asset.projectId || !projectIds.includes(asset.projectId)) {
      throw new Error("Cleanup ownership guard rejected an unexpected asset.");
    }
    const expectedPrefix = `development/owners/${asset.ownerId}/projects/${asset.projectId}/assets/${asset.id}/`;
    if (!asset.objectKey.startsWith(expectedPrefix) || !/^[a-f0-9]{32}$/i.test(asset.objectKey.slice(expectedPrefix.length))) {
      throw new Error("Cleanup object-key guard rejected an unexpected key.");
    }
    const key = asset.objectKey as StorageObjectKey;
    const existed = await storage.objectExists(key);
    await storage.deleteObject(key);
    if (existed) deletedExistingObjects += 1;
  }
  await database.$transaction(async (transaction) => {
    await transaction.activityLog.deleteMany({ where: { ownerId: { in: userIds } } });
    const deletedAssets = await transaction.asset.deleteMany({ where: { id: { in: [...assetIds] }, ownerId: { in: userIds } } });
    databaseRecordsDeleted += deletedAssets.count;
    await transaction.project.deleteMany({ where: { id: { in: projectIds }, ownerId: { in: userIds } } });
    await transaction.session.deleteMany({ where: { userId: { in: userIds } } });
    await transaction.loginAttempt.deleteMany({ where: { userId: { in: userIds } } });
    await transaction.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

let acceptancePassed = false;

try {
  safeResult("ENVIRONMENT_STATUS", "PASS");
  await assertCredentialScope();
  safeResult("R2_MINIMAL_HEAD_SCOPE", "PASS");
  await waitForServer();

  const passwordA = `R2 acceptance ${randomBytes(24).toString("hex")}`;
  const passwordB = `R2 acceptance ${randomBytes(24).toString("hex")}`;
  const [userA, userB] = await database.$transaction([
    database.user.create({ data: {
      email: `${runId}-a@integration.invalid`, passwordHash: await hashPassword(passwordA), role: "OWNER",
    } }),
    database.user.create({ data: {
      email: `${runId}-b@integration.invalid`, passwordHash: await hashPassword(passwordB), role: "OWNER",
    } }),
  ]);
  userIds.push(userA.id, userB.id);
  const project = await database.project.create({ data: {
    ownerId: userA.id, name: `R2 Acceptance ${runId}`, slug: runId, type: "MIXED",
  } });
  projectIds.push(project.id);
  const [cookieA, cookieB] = await Promise.all([
    login(userA.email, passwordA),
    login(userB.email, passwordB),
  ]);
  safeResult("AUTHENTICATED_TEST_ACCOUNTS", "PASS");

  const pixelsA = Buffer.alloc(32 * 24 * 3, 20);
  const pixelsB = Buffer.alloc(32 * 24 * 3, 220);
  const fixture = await sharp(pixelsA, { raw: { width: 32, height: 24, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  const alternate = await sharp(pixelsB, { raw: { width: 32, height: 24, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  if (fixture.byteLength !== alternate.byteLength) throw new Error("Replay fixtures are not equal length.");

  const happy = await initiate(cookieA, project.id, fixture.byteLength, "acceptance.png");
  const signedHeaderNames = Object.keys(happy.requiredHeaders).map((name) => name.toLowerCase());
  if (!signedHeaderNames.includes("content-type") || !signedHeaderNames.includes("content-length") ||
      !signedHeaderNames.includes("x-amz-meta-assetid")) {
    throw new Error("Presigned PUT contract is missing required signed headers.");
  }
  safeResult("SIGNED_HEADERS", "PASS");
  await corsPreflight(happy.url);
  safeResult("R2_CORS_PREFLIGHT", "PASS");

  const uploaded = await put(happy, fixture);
  if (!uploaded.ok) {
    throw new Error(`Real R2 PUT failed (${uploaded.status}, ${await safeR2ErrorCode(uploaded)}).`);
  }
  const etag = uploaded.headers.get("etag");
  if (!etag) throw new Error("R2 PUT response did not expose ETag.");
  safeResult("R2_PUT", "PASS");

  const completed = await complete(cookieA, happy.assetId, { etag, checksumSha256: sha256(fixture) });
  if (completed.response.status !== 200 || (completed.body["asset"] as JsonRecord)?.["status"] !== "READY") {
    throw new Error(`Complete failed (${completed.response.status}).`);
  }
  const ready = await database.asset.findUniqueOrThrow({ where: { id: happy.assetId } });
  if (ready.status !== "READY" || ready.checksumSha256 !== sha256(fixture) || ready.width !== 32 || ready.height !== 24) {
    throw new Error("READY database verification mismatch.");
  }
  await storage.headObject(ready.objectKey as StorageObjectKey);
  safeResult("R2_HEAD_AND_READY", "PASS");

  const readContract = await apiJson(`/api/assets/${happy.assetId}/read-url`, { cookie: cookieA });
  if (readContract.response.status !== 200) throw new Error("Signed read authorization failed.");
  const readUrl = String((readContract.body["result"] as JsonRecord)["url"]);
  const downloaded = await fetch(readUrl);
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  if (!downloaded.ok || sha256(downloadedBytes) !== sha256(fixture)) {
    throw new Error("Signed GET checksum mismatch.");
  }
  safeResult("R2_SIGNED_GET_CHECKSUM", "PASS");

  const unsignedUrl = new URL(happy.url);
  unsignedUrl.search = "";
  const unsigned = await fetch(unsignedUrl, { method: "GET", redirect: "manual" });
  if (unsigned.ok) throw new Error("Private bucket object was readable without a signature.");
  safeResult("PRIVATE_BUCKET_ACCESS", "PASS");

  const duplicate = await complete(cookieA, happy.assetId, { etag, checksumSha256: sha256(fixture) });
  if (duplicate.response.status !== 200) throw new Error("Duplicate completion was not idempotent.");
  safeResult("DUPLICATE_COMPLETION", "PASS");

  const deniedRead = await apiJson(`/api/assets/${happy.assetId}/read-url`, { cookie: cookieB });
  const deniedComplete = await complete(cookieB, happy.assetId, {});
  const deniedInitiate = await initiateRaw(cookieB, project.id, fixture.byteLength, "idor.png");
  if (deniedRead.response.status !== 404 || deniedComplete.response.status !== 404 ||
      deniedInitiate.response.status !== 404) {
    throw new Error("Cross-owner isolation failed.");
  }
  safeResult("CROSS_OWNER_ISOLATION", "PASS");

  const invalidMime = await initiateRaw(
    cookieA,
    project.id,
    fixture.byteLength,
    "invalid.gif",
    "image/gif",
  );
  if (invalidMime.response.status !== 400) throw new Error("Invalid MIME was not rejected.");
  safeResult("INVALID_MIME", "PASS");

  const oversized = await initiateRaw(
    cookieA,
    project.id,
    config.maxUploadBytes + 1,
    "oversized.png",
  );
  if (oversized.response.status !== 400) throw new Error("Oversized declaration was not rejected.");
  safeResult("OVERSIZED_UPLOAD", "PASS");

  const missing = await initiate(cookieA, project.id, fixture.byteLength, "missing.png");
  const missingComplete = await complete(cookieA, missing.assetId);
  if (missingComplete.response.status !== 422) throw new Error("Missing object was not rejected.");
  safeResult("MISSING_OBJECT", "PASS");

  const expired = await initiate(cookieA, project.id, fixture.byteLength, "expired.png");
  await database.asset.update({
    where: { id: expired.assetId },
    data: { uploadExpiresAt: new Date(Date.now() - 60_000) },
  });
  const expiredComplete = await complete(cookieA, expired.assetId);
  if (expiredComplete.response.status !== 410) throw new Error("Expired upload contract was not rejected.");
  safeResult("EXPIRED_UPLOAD_CONTRACT", "PASS");

  const mismatch = await initiate(cookieA, project.id, fixture.byteLength, "etag-mismatch.png");
  const mismatchPut = await put(mismatch, fixture);
  if (!mismatchPut.ok) throw new Error(`ETag mismatch setup PUT failed (${mismatchPut.status}).`);
  const mismatchComplete = await complete(cookieA, mismatch.assetId, { etag: "\"acceptance-mismatch\"" });
  if (mismatchComplete.response.status !== 422) throw new Error("ETag mismatch was not rejected.");
  safeResult("ETAG_MISMATCH", "PASS");

  const invalidImage = await initiate(cookieA, project.id, fixture.byteLength, "invalid-image.png");
  const invalidBytes = Buffer.alloc(fixture.byteLength, 0x5a);
  const invalidPut = await put(invalidImage, invalidBytes);
  if (!invalidPut.ok) throw new Error(`Invalid image setup PUT failed (${invalidPut.status}).`);
  const invalidEtag = invalidPut.headers.get("etag");
  if (!invalidEtag) throw new Error("Invalid image setup PUT did not expose ETag.");
  const invalidComplete = await complete(cookieA, invalidImage.assetId, { etag: invalidEtag });
  if (invalidComplete.response.status !== 422) throw new Error("Invalid image content was not rejected.");
  safeResult("BOUNDED_IMAGE_VERIFICATION", "PASS");

  const shortUpload = await initiate(cookieA, project.id, fixture.byteLength, "short.png");
  const shortPut = await put(shortUpload, fixture.subarray(0, fixture.byteLength - 1));
  if (shortPut.ok) {
    const shortEtag = shortPut.headers.get("etag");
    if (!shortEtag) throw new Error("Short PUT did not expose ETag.");
    const shortComplete = await complete(cookieA, shortUpload.assetId, { etag: shortEtag });
    if (shortComplete.response.status !== 422) {
      throw new Error("Content-length mismatch passed both PUT and completion verification.");
    }
    safeResult("CONTENT_LENGTH_ENFORCEMENT", "OBSERVED", "REJECTED_AT_COMPLETION");
  } else {
    safeResult("CONTENT_LENGTH_ENFORCEMENT", "PASS", "REJECTED_AT_PUT");
  }

  const replaySame = await put(happy, fixture);
  safeResult("PRESIGNED_PUT_REPLAY_SAME_BYTES", "OBSERVED", replaySame.ok ? "ALLOWED" : "REJECTED");

  const replayOverwrite = await put(happy, alternate);
  safeResult("PRESIGNED_PUT_OVERWRITE", "OBSERVED", replayOverwrite.ok ? "ALLOWED" : "REJECTED");
  if (replayOverwrite.ok) {
    const afterOverwriteRead = await apiJson(`/api/assets/${happy.assetId}/read-url`, { cookie: cookieA });
    if (afterOverwriteRead.response.status !== 503) {
      throw new Error("Critical integrity failure: overwritten READY object still received a read URL.");
    }
    safeResult("READY_OBJECT_INTEGRITY_GUARD", "PASS");
  }

  acceptancePassed = true;
} finally {
  try {
    await cleanup();
  } finally {
    console.log(`OBJECTS_CREATED=${createdObjectKeys.size}`);
    console.log(`OBJECTS_DELETED=${deletedExistingObjects}`);
    console.log(`DATABASE_ASSETS_DELETED=${databaseRecordsDeleted}`);
    await database.$disconnect();
  }
}

if (acceptancePassed) safeResult("REAL_R2_ACCEPTANCE", "PASS");
