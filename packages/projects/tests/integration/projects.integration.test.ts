import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "@archrender/database";

import { ProjectApplicationError } from "../../src/errors";
import { ProjectService } from "../../src/project-service";

const database = createDatabaseClient();
const service = new ProjectService(database);
const runId = `m2c-${Date.now()}-${randomUUID()}`;
const userIds: string[] = [];
const projectIds: string[] = [];
let ownerA = { id: "", role: "OWNER" as const };
let ownerB = { id: "", role: "OWNER" as const };

beforeAll(async () => {
  const users = await database.$transaction([
    database.user.create({ data: { email: `${runId}-a@integration.invalid`, passwordHash: "m2c-test-hash", role: "ADMIN" } }),
    database.user.create({ data: { email: `${runId}-b@integration.invalid`, passwordHash: "m2c-test-hash", role: "ADMIN" } }),
  ]);
  userIds.push(...users.map(({ id }) => id));
  ownerA = { id: users[0]!.id, role: "OWNER" };
  ownerB = { id: users[1]!.id, role: "OWNER" };
});

afterAll(async () => {
  try {
    await database.$transaction(async (transaction) => {
      await transaction.activityLog.deleteMany({ where: { ownerId: { in: userIds } } });
      await transaction.project.deleteMany({ where: { id: { in: projectIds }, ownerId: { in: userIds } } });
      await transaction.user.deleteMany({ where: { id: { in: userIds } } });
    });
    expect(await database.project.count({ where: { id: { in: projectIds } } })).toBe(0);
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  } finally {
    await database.$disconnect();
  }
});

describe.sequential("Project management on PostgreSQL development", () => {
  it("creates idempotently and enforces owner isolation against IDOR", async () => {
    const requestId = randomUUID();
    const first = await service.create(ownerA, { name: `${runId} Alpha`, description: "integration", requestId });
    const retry = await service.create(ownerA, { name: `${runId} Alpha`, description: "integration", requestId });
    projectIds.push(first.id);

    expect(retry.id).toBe(first.id);
    expect(await database.project.count({ where: { id: first.id } })).toBe(1);
    await expect(service.get(ownerB, first.id)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" } satisfies Partial<ProjectApplicationError>);
    await expect(service.update(ownerB, first.id, { name: "IDOR", description: "", expectedUpdatedAt: first.updatedAt })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" } satisfies Partial<ProjectApplicationError>);
  });

  it("lists with database pagination, search, filter, and sort", async () => {
    for (let index = 0; index < 7; index += 1) {
      const created = await service.create(ownerA, { name: `${runId} Search ${String(index).padStart(2, "0")}`, requestId: randomUUID() });
      projectIds.push(created.id);
    }
    const foreign = await service.create(ownerB, { name: `${runId} Search foreign`, requestId: randomUUID() });
    projectIds.push(foreign.id);

    const page = await service.list(ownerA, { search: `${runId} Search`, status: "ACTIVE", sort: "name", direction: "asc", page: 2, pageSize: 3 });
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(3);
    expect(page.items.every((item) => item.name.includes("Search"))).toBe(true);
    expect(page.items.map((item) => item.name)).toEqual([...page.items.map((item) => item.name)].sort());
  });

  it("updates with optimistic concurrency and archives/restores without deleting relations", async () => {
    const created = await service.create(ownerA, { name: `${runId} Lifecycle`, requestId: randomUUID() });
    projectIds.push(created.id);
    const updated = await service.update(ownerA, created.id, { name: `${runId} Lifecycle Updated`, description: "updated", expectedUpdatedAt: created.updatedAt });
    await expect(service.update(ownerA, created.id, { name: "Stale write", description: "", expectedUpdatedAt: created.updatedAt })).rejects.toMatchObject({ code: "PROJECT_CONFLICT" } satisfies Partial<ProjectApplicationError>);

    const archived = await service.archive(ownerA, created.id, { expectedUpdatedAt: updated.updatedAt });
    expect(archived.status).toBe("ARCHIVED");
    await expect(service.update(ownerA, created.id, { name: "Archived write", description: "", expectedUpdatedAt: archived.updatedAt })).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" } satisfies Partial<ProjectApplicationError>);
    const restored = await service.restore(ownerA, created.id, { expectedUpdatedAt: archived.updatedAt });
    expect(restored.status).toBe("ACTIVE");
    expect(await database.project.count({ where: { id: created.id } })).toBe(1);
  });
});
