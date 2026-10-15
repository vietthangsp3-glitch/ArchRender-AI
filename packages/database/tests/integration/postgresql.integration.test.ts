import "dotenv/config";

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "../../src/client.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { PersistenceService } from "../../src/persistence-service.js";

const database = createDatabaseClient();
const persistence = new PersistenceService(database);
const runId = `m2a-${Date.now()}-${randomUUID()}`;
const ownerIds: string[] = [];

async function cleanTestData() {
  if (ownerIds.length === 0) return;

  await database.$transaction(async (transaction) => {
    const ownerFilter = { in: ownerIds };
    const jobs = await transaction.renderJob.findMany({
      where: { ownerId: ownerFilter },
      select: { id: true },
    });
    const jobIds = jobs.map(({ id }) => id);

    await transaction.activityLog.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.providerUsageRecord.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.gPUAllocation.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.renderJobEvent.deleteMany({ where: { ownerId: ownerFilter } });

    if (jobIds.length > 0) {
      await transaction.renderJobOutput.deleteMany({ where: { jobId: { in: jobIds } } });
      await transaction.renderJobInput.deleteMany({ where: { jobId: { in: jobIds } } });
    }

    await transaction.renderJob.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.workflowVersion.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.workflowPreset.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.assetStorageObject.deleteMany({
      where: { ownerId: ownerFilter, sourceObjectId: { not: null } },
    });
    await transaction.assetStorageObject.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.asset.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.project.deleteMany({ where: { ownerId: ownerFilter } });
    await transaction.session.deleteMany({ where: { userId: ownerFilter } });
    await transaction.user.deleteMany({ where: { id: ownerFilter } });
  });
}

afterAll(async () => {
  try {
    await cleanTestData();
    const remainingOwners = await database.user.count({
      where: { id: { in: ownerIds } },
    });
    expect(remainingOwners).toBe(0);
  } finally {
    await database.$disconnect();
  }
});

describe.sequential("PostgreSQL development acceptance", () => {
  it("has the Phase 2A migration recorded", async () => {
    const rows = await database.$queryRaw<Array<{ migration_name: string }>>(
      Prisma.sql`
        SELECT migration_name
        FROM "_prisma_migrations"
        WHERE migration_name = '20261014000100_phase_2a_database_foundation'
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      `,
    );

    expect(rows).toHaveLength(1);
  });

  it("validates CRUD, constraints, rollback, idempotency, and owner isolation", async () => {
    const [ownerA, ownerB] = await database.$transaction([
      database.user.create({
        data: {
          email: `${runId}-owner-a@integration.invalid`,
          passwordHash: "integration-test-not-a-real-password-hash",
          displayName: `M2A Test Owner A ${runId}`,
          role: "ADMIN",
        },
      }),
      database.user.create({
        data: {
          email: `${runId}-owner-b@integration.invalid`,
          passwordHash: "integration-test-not-a-real-password-hash",
          displayName: `M2A Test Owner B ${runId}`,
          role: "ADMIN",
        },
      }),
    ]);
    ownerIds.push(ownerA.id, ownerB.id);

    const projectA = await persistence.projects.create({
      ownerId: ownerA.id,
      name: `M2A Project A ${runId}`,
      slug: `${runId}-project-a`,
      type: "INTERIOR",
    });
    const projectB = await persistence.projects.create({
      ownerId: ownerB.id,
      name: `M2A Project B ${runId}`,
      slug: `${runId}-project-b`,
      type: "EXTERIOR",
    });

    expect(await persistence.projects.findById(ownerB.id, projectA.id)).toBeNull();
    expect(await persistence.projects.findById(ownerA.id, projectB.id)).toBeNull();

    const updated = await persistence.projects.update({
      ownerId: ownerA.id,
      id: projectA.id,
      description: `Updated by ${runId}`,
    });
    expect(updated.description).toBe(`Updated by ${runId}`);

    const disposable = await persistence.projects.create({
      ownerId: ownerA.id,
      name: `M2A Disposable ${runId}`,
      slug: `${runId}-disposable`,
      type: "MIXED",
    });
    await persistence.projects.delete(ownerA.id, disposable.id);
    expect(await persistence.projects.findById(ownerA.id, disposable.id)).toBeNull();

    const assetA = await persistence.assets.create({
      ownerId: ownerA.id,
      projectId: projectA.id,
      type: "SOURCE_RENDER",
      status: "READY",
      storageLayout: "LEGACY_SINGLE_OBJECT",
      integrityStatus: "LEGACY_GUARDED",
      bucket: "archrender-integration-test",
      objectKey: `${runId}/source-render.png`,
      originalName: `M2A-${runId}.png`,
      contentType: "image/png",
    });
    expect(assetA.ownerId).toBe(ownerA.id);
    expect(assetA).toMatchObject({
      status: "READY",
      storageLayout: "LEGACY_SINGLE_OBJECT",
      integrityStatus: "LEGACY_GUARDED",
    });

    await expect(
      database.asset.create({
        data: {
          ownerId: ownerA.id,
          projectId: projectA.id,
          type: "SOURCE_RENDER",
          status: "READY",
          storageLayout: "LEGACY_SINGLE_OBJECT",
          integrityStatus: "PENDING",
          bucket: "archrender-integration-test",
          objectKey: `${runId}/invalid-ready.png`,
        },
      }),
    ).rejects.toMatchObject({ code: "P2039" });

    await expect(
      persistence.assets.create({
        ownerId: ownerA.id,
        projectId: projectB.id,
        type: "SOURCE_RENDER",
        bucket: "archrender-integration-test",
        objectKey: `${runId}/cross-owner.png`,
      }),
    ).rejects.toThrow();

    const preset = await database.workflowPreset.create({
      data: {
        ownerId: ownerA.id,
        projectId: projectA.id,
        name: `M2A Preset ${runId}`,
        kind: "IMAGE_RENDER",
        draftConfiguration: {
          backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1",
          modelFamily: "integration", conditioning: ["IMAGE"],
        },
      },
    });
    const workflowVersion = await database.workflowVersion.create({
      data: {
        ownerId: ownerA.id,
        presetId: preset.id,
        version: 1,
        parameterSchemaVersion: "test-v1",
        workflowReference: `integration://${runId}`,
        parameters: { testRun: runId },
      },
    });

    const idempotencyKey = `${runId}-same-request`;
    const jobA = await persistence.renderJobs.create({
      ownerId: ownerA.id,
      projectId: projectA.id,
      workflowVersionId: workflowVersion.id,
      type: "IMAGE_RENDER",
      idempotencyKey,
      parameters: { testRun: runId },
    });

    await expect(
      persistence.renderJobs.create({
        ownerId: ownerA.id,
        projectId: projectA.id,
        workflowVersionId: workflowVersion.id,
        type: "IMAGE_RENDER",
        idempotencyKey,
        parameters: { duplicate: true },
      }),
    ).rejects.toThrow();

    const jobB = await persistence.renderJobs.create({
      ownerId: ownerB.id,
      projectId: projectB.id,
      type: "IMAGE_RENDER",
      idempotencyKey,
      parameters: { testRun: runId },
    });
    expect(jobB.ownerId).toBe(ownerB.id);
    expect(await persistence.renderJobs.findById(ownerB.id, jobA.id)).toBeNull();

    await expect(
      database.session.create({
        data: {
          userId: randomUUID(),
          tokenHash: `${runId}-invalid-fk`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();

    await expect(database.project.delete({ where: { id: projectA.id } })).rejects.toThrow();

    const rollbackSlug = `${runId}-rollback`;
    await expect(
      persistence.transaction(async (transaction) => {
        await transaction.projects.create({
          ownerId: ownerA.id,
          name: `M2A Rollback ${runId}`,
          slug: rollbackSlug,
          type: "MIXED",
        });
        await transaction.activityLogs.create({
          ownerId: ownerA.id,
          actorUserId: ownerA.id,
          action: "M2A_INTEGRATION_ROLLBACK",
          entityType: "TEST",
          entityId: runId,
        });
        throw new Error("intentional integration rollback");
      }),
    ).rejects.toThrow("intentional integration rollback");

    expect(
      await database.project.count({ where: { ownerId: ownerA.id, slug: rollbackSlug } }),
    ).toBe(0);
    expect(
      await database.activityLog.count({
        where: { ownerId: ownerA.id, entityId: runId },
      }),
    ).toBe(0);
  });
});
