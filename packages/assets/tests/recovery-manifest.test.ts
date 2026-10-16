import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readRecoveryManifest,
  removeRecoveryManifestIfResolved,
  runAfterRecoveryIdentityPersisted,
  writeDurableAtomicManifest,
  type RecoveryManifest,
} from "../scripts/recovery-manifest.js";

const temporaryDirectories: string[] = [];

function fixture(): RecoveryManifest {
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const assetId = "00000000-0000-4000-8000-000000000003";
  return {
    version: 1,
    runId: "m2dd2-r2-1792022400000-00000000-0000-4000-8000-000000000004",
    userIds: [ownerId],
    projectIds: [projectId],
    assetIds: [assetId],
    uploadRequestIds: ["00000000-0000-4000-8000-000000000005"],
    objects: [{
      assetId,
      ownerId,
      projectId,
      role: "STAGING",
      key: `development/owners/${ownerId}/projects/${projectId}/assets/${assetId}/staging/${"a".repeat(32)}`,
      checksumSha256: "b".repeat(64),
    }],
  };
}

async function manifestPath() {
  const directory = await mkdtemp(join(tmpdir(), "archrender-r2-manifest-"));
  temporaryDirectories.push(directory);
  return join(directory, "recovery.json");
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("durable recovery manifest on the real filesystem", () => {
  it("runs on Windows and completes write, sync, rename, reopen, sync, and read-back", async () => {
    expect(process.platform).toBe("win32");
    const path = await manifestPath();
    const manifest = fixture();

    await writeDurableAtomicManifest(path, manifest);

    await expect(readRecoveryManifest(path)).resolves.toEqual(manifest);
    expect(await readdir(join(path, ".."))).toEqual(["recovery.json"]);
  });

  it("recovers solely from the persisted file after simulated process-state loss", async () => {
    const path = await manifestPath();
    await writeDurableAtomicManifest(path, fixture());

    const recoveredByFreshReader = await readRecoveryManifest(path);

    expect(recoveredByFreshReader.objects).toHaveLength(1);
    expect(recoveredByFreshReader.uploadRequestIds).toHaveLength(1);
  });

  it("persists exact GRID and DETAIL derivative recovery identities", async () => {
    const path = await manifestPath();
    const manifest = fixture();
    const base = manifest.objects[0]!;
    manifest.objects.push(
      { ...base, role: "THUMBNAIL_GRID", key: base.key.replace(`/staging/${"a".repeat(32)}`, `/derivatives/grid/${"c".repeat(32)}`), checksumSha256: null },
      { ...base, role: "THUMBNAIL_DETAIL", key: base.key.replace(`/staging/${"a".repeat(32)}`, `/derivatives/detail/${"d".repeat(32)}`), checksumSha256: "e".repeat(64) },
    );

    await writeDurableAtomicManifest(path, manifest);

    await expect(readRecoveryManifest(path)).resolves.toEqual(manifest);
  });

  it("atomically replaces an existing manifest on Windows", async () => {
    const path = await manifestPath();
    const original = fixture();
    const replacement = { ...original, assetIds: [...original.assetIds, randomUUID()] };
    await writeDurableAtomicManifest(path, original);

    await writeDurableAtomicManifest(path, replacement);

    await expect(readRecoveryManifest(path)).resolves.toEqual(replacement);
    expect(await readdir(join(path, ".."))).toEqual(["recovery.json"]);
  });

  it("preserves the last valid recovery state when an atomic rename is denied", async () => {
    const path = await manifestPath();
    const original = fixture();
    await writeDurableAtomicManifest(path, original);
    const replacement = { ...original, assetIds: [...original.assetIds, randomUUID()] };
    const denyRename: typeof rename = async () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };

    await expect(writeDurableAtomicManifest(path, replacement, { renameOperation: denyRename }))
      .rejects.toMatchObject({ code: "EPERM" });

    await expect(readRecoveryManifest(path)).resolves.toEqual(original);
    expect(await readdir(join(path, ".."))).toEqual(["recovery.json"]);
  });

  it("persists recovery identity before invoking a mutation", async () => {
    const path = await manifestPath();
    const manifest = fixture();
    let mutationObservedDurableIdentity = false;

    await runAfterRecoveryIdentityPersisted({
      path,
      manifest,
      hasRecoveryIdentity: (candidate) => candidate.objects[0]?.checksumSha256 === "b".repeat(64),
      mutation: async () => {
        mutationObservedDurableIdentity = (await readRecoveryManifest(path)).objects.length === 1;
      },
    });

    expect(mutationObservedDurableIdentity).toBe(true);
    await expect(runAfterRecoveryIdentityPersisted({
      path,
      manifest,
      hasRecoveryIdentity: () => false,
      mutation: async () => undefined,
    })).rejects.toThrow("RECOVERY_IDENTITY_MISSING");
  });

  it("rejects secret-bearing fields and never serializes credentials, cookies, or URLs", async () => {
    const path = await manifestPath();
    const manifest = fixture();
    await writeDurableAtomicManifest(path, manifest);
    const serialized = (await readFile(path, "utf8")).toLowerCase();

    expect(serialized).not.toMatch(/credential|password|secret|cookie|token|signedurl|https?:\/\//);
    await expect(writeDurableAtomicManifest(path, { ...manifest, cookie: "forbidden" } as RecoveryManifest))
      .rejects.toThrow("RECOVERY_MANIFEST_UNSAFE_FIELDS");
  });

  it("accepts staging recovery identities but rejects production object keys", async () => {
    const path = await manifestPath();
    const staging = fixture();
    staging.objects[0]!.key = staging.objects[0]!.key.replace(/^development\//, "staging/");
    await writeDurableAtomicManifest(path, staging);
    await expect(readRecoveryManifest(path)).resolves.toEqual(staging);

    const production = fixture();
    production.objects[0]!.key = production.objects[0]!.key.replace(/^development\//, "production/");
    await expect(writeDurableAtomicManifest(path, production)).rejects.toThrow("RECOVERY_MANIFEST_INVALID");
  });

  it("retains unresolved manifests and removes only explicitly resolved obligations", async () => {
    const path = await manifestPath();
    await writeDurableAtomicManifest(path, fixture());

    await expect(removeRecoveryManifestIfResolved(path, {})).rejects.toThrow("RECOVERY_OBLIGATION_UNRESOLVED");
    await expect(readRecoveryManifest(path)).resolves.toBeDefined();

    await removeRecoveryManifestIfResolved(path, { cleanupVerified: true });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeDurableAtomicManifest(path, fixture());
    await removeRecoveryManifestIfResolved(path, { noMutationOccurred: true });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the runtime manifest directory ignored by git", async () => {
    const gitignore = await readFile(new URL("../../../.gitignore", import.meta.url), "utf8");
    const patterns = gitignore.split(/\r?\n/);
    expect(patterns.some((pattern) => pattern === "packages/assets/.r2-acceptance/" || pattern === "**/.r2-acceptance/")).toBe(true);
  });
});
