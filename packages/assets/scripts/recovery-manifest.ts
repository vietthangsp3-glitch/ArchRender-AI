import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type RecoveryObjectRole = "STAGING" | "ORIGINAL" | "THUMBNAIL_GRID" | "THUMBNAIL_DETAIL" | "LEGACY";

export type RecoveryObject = {
  assetId: string;
  ownerId: string;
  projectId: string;
  role: RecoveryObjectRole;
  key: string;
  checksumSha256: string | null;
};

export type RecoveryManifest = {
  version: 1;
  runId: string;
  userIds: string[];
  projectIds: string[];
  assetIds: string[];
  uploadRequestIds: string[];
  objects: RecoveryObject[];
};

type PathInput = string | URL;
type RenameOperation = typeof rename;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runIdPattern = /^m2dd2-r2-[0-9]+-[0-9a-f-]{36}$/i;
const checksumPattern = /^[0-9a-f]{64}$/i;
const objectKeyPattern = /^development\/owners\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}\/(?:staging\/|original\/|derivatives\/(?:grid|detail)\/)?[0-9a-f]{32}$/i;

function pathString(input: PathInput) {
  return input instanceof URL ? fileURLToPath(input) : input;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key, index) => key === [...allowed].sort()[index]);
}

export function assertRecoveryManifestSafe(value: unknown): asserts value is RecoveryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RECOVERY_MANIFEST_INVALID");
  const manifest = value as Record<string, unknown>;
  if (!exactKeys(manifest, ["version", "runId", "userIds", "projectIds", "assetIds", "uploadRequestIds", "objects"])) {
    throw new Error("RECOVERY_MANIFEST_UNSAFE_FIELDS");
  }
  if (manifest["version"] !== 1 || typeof manifest["runId"] !== "string" || !runIdPattern.test(manifest["runId"])) {
    throw new Error("RECOVERY_MANIFEST_INVALID");
  }
  for (const field of ["userIds", "projectIds", "assetIds", "uploadRequestIds"] as const) {
    const values = manifest[field];
    if (!Array.isArray(values) || values.some((id) => typeof id !== "string" || !uuidPattern.test(id))) {
      throw new Error("RECOVERY_MANIFEST_INVALID");
    }
  }
  if (!Array.isArray(manifest["objects"])) throw new Error("RECOVERY_MANIFEST_INVALID");
  for (const candidate of manifest["objects"]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("RECOVERY_MANIFEST_INVALID");
    const object = candidate as Record<string, unknown>;
    if (!exactKeys(object, ["assetId", "ownerId", "projectId", "role", "key", "checksumSha256"])) {
      throw new Error("RECOVERY_MANIFEST_UNSAFE_FIELDS");
    }
    if (
      typeof object["assetId"] !== "string" || !uuidPattern.test(object["assetId"]) ||
      typeof object["ownerId"] !== "string" || !uuidPattern.test(object["ownerId"]) ||
      typeof object["projectId"] !== "string" || !uuidPattern.test(object["projectId"]) ||
      !["STAGING", "ORIGINAL", "THUMBNAIL_GRID", "THUMBNAIL_DETAIL", "LEGACY"].includes(String(object["role"])) ||
      typeof object["key"] !== "string" || !objectKeyPattern.test(object["key"]) ||
      !(object["checksumSha256"] === null || (typeof object["checksumSha256"] === "string" && checksumPattern.test(object["checksumSha256"])))
    ) {
      throw new Error("RECOVERY_MANIFEST_INVALID");
    }
  }
}

export async function readRecoveryManifest(path: PathInput) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertRecoveryManifestSafe(value);
  return value;
}

export async function writeDurableAtomicManifest(
  path: PathInput,
  manifest: RecoveryManifest,
  options: { renameOperation?: RenameOperation } = {},
) {
  assertRecoveryManifestSafe(manifest);
  const target = pathString(path);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  let renamed = false;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (options.renameOperation ?? rename)(temporary, target);
    renamed = true;
    const stableHandle = await open(target, "r+");
    try {
      await stableHandle.sync();
    } finally {
      await stableHandle.close();
    }
    await readRecoveryManifest(target);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

export async function runAfterRecoveryIdentityPersisted<T>(input: {
  path: PathInput;
  manifest: RecoveryManifest;
  hasRecoveryIdentity: (manifest: RecoveryManifest) => boolean;
  mutation: () => Promise<T>;
}) {
  if (!input.hasRecoveryIdentity(input.manifest)) throw new Error("RECOVERY_IDENTITY_MISSING");
  await writeDurableAtomicManifest(input.path, input.manifest);
  return input.mutation();
}

export async function removeRecoveryManifestIfResolved(
  path: PathInput,
  resolution: { noMutationOccurred?: boolean; cleanupVerified?: boolean },
) {
  if (!resolution.noMutationOccurred && !resolution.cleanupVerified) {
    throw new Error("RECOVERY_OBLIGATION_UNRESOLVED");
  }
  await rm(path, { force: true });
}
