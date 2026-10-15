import { randomUUID } from "node:crypto";
import type { AssetType, PrismaClient } from "@archrender/database";

interface VerifiedAssetFixtureInput {
  ownerId: string;
  projectId: string;
  runId: string;
  type?: AssetType;
  checksumCharacter?: string;
}

export async function createVerifiedImmutableAssetFixture(
  database: PrismaClient,
  input: VerifiedAssetFixtureInput,
) {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_FIXTURE_ENVIRONMENT_REQUIRED");
  const fixtureId = randomUUID();
  const checksum = (input.checksumCharacter ?? "a").repeat(64);
  const bucket = "archrender-integration-fixtures";
  const objectKey = `m2e/${input.runId}/${fixtureId}/original.png`;
  return database.$transaction(async (transaction) => {
    const asset = await transaction.asset.create({
      data: {
        ownerId: input.ownerId,
        projectId: input.projectId,
        type: input.type ?? "SOURCE_IMAGE",
        status: "READY",
        bucket,
        objectKey,
        originalName: "synthetic-8x8.png",
        contentType: "image/png",
        byteSize: 68n,
        width: 8,
        height: 8,
        checksumSha256: checksum,
        storageLayout: "STAGED_IMMUTABLE_V1",
        integrityStatus: "VERIFIED_IMMUTABLE",
        verifiedAt: new Date(),
        finalizedAt: new Date(),
      },
    });
    const storageObject = await transaction.assetStorageObject.create({
      data: {
        assetId: asset.id,
        ownerId: input.ownerId,
        role: "ORIGINAL",
        state: "VERIFIED",
        bucket,
        objectKey,
        contentType: "image/png",
        byteSize: 68n,
        width: 8,
        height: 8,
        checksumSha256: checksum,
        storageEtag: `"${"b".repeat(32)}"`,
        immutableAt: new Date(),
      },
    });
    return { asset, storageObject };
  });
}
