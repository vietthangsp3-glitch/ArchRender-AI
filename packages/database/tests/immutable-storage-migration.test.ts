import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../prisma/migrations/20261015000100_phase_2d_d_immutable_asset_storage/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

const schema = readFileSync(
  fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
  "utf8",
);

describe("immutable asset storage migration contract", () => {
  it("is transactional, bounded, and remains an unapplied operator checkpoint", () => {
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '5min';");
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration).toContain("OPERATOR CHECKPOINT");
  });

  it("classifies every current AssetStatus explicitly and preserves READY as legacy", () => {
    for (const status of [
      "PENDING_UPLOAD",
      "VERIFYING",
      "READY",
      "REJECTED",
      "QUARANTINED",
      "DELETED",
    ]) {
      expect(migration).toMatch(new RegExp(`WHEN '${status}' THEN`));
    }

    expect(migration).toContain(
      "WHEN 'READY' THEN 'LEGACY_GUARDED'::\"AssetIntegrityStatus\"",
    );
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"AssetStorageObject"/i);
  });

  it("defaults new assets to fail-closed PENDING rather than verified or legacy", () => {
    expect(migration).toMatch(
      /ADD COLUMN "integrityStatus" "AssetIntegrityStatus" NOT NULL DEFAULT 'PENDING'/,
    );
    expect(schema).toContain(
      "integrityStatus AssetIntegrityStatus @default(PENDING)",
    );
  });

  it("retains storage metadata and lineage with restrictive composite foreign keys", () => {
    expect(migration).not.toContain("ON DELETE CASCADE");
    expect(migration).not.toContain("ON DELETE SET NULL");
    expect(migration).toMatch(
      /FOREIGN KEY \("assetId", "ownerId"\)[\s\S]*?ON DELETE RESTRICT/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("sourceObjectId", "assetId", "ownerId"\)[\s\S]*?REFERENCES "AssetStorageObject"\("id", "assetId", "ownerId"\)[\s\S]*?ON DELETE RESTRICT/,
    );
    expect(schema).toContain("onDelete: Restrict");
    expect(schema).toContain("@@unique([id, assetId, ownerId])");
  });

  it("enforces verified identity, lineage shape, checksum, size, and tombstones", () => {
    for (const constraint of [
      "Asset_integrity_state_check",
      "AssetStorageObject_source_lineage_check",
      "AssetStorageObject_verified_identity_check",
      "AssetStorageObject_checksumSha256_check",
      "AssetStorageObject_byteSize_check",
      "AssetStorageObject_deleted_tombstone_check",
    ]) {
      expect(migration).toContain(`CONSTRAINT \"${constraint}\"`);
    }
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "AssetStorageObject_assetId_role_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "AssetStorageObject_bucket_objectKey_key"',
    );
  });
});
