import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@archrender/database";

import { ProjectApplicationError } from "../src/errors";
import { ProjectService } from "../src/project-service";
import { createProjectSchema, listProjectsSchema } from "../src/schemas";

const principal = { id: "00000000-0000-4000-8000-000000000001", role: "OWNER" as const };
const now = new Date("2026-10-14T00:00:00.000Z");
const project = {
  id: "00000000-0000-4000-8000-000000000010",
  ownerId: principal.id,
  name: "Villa Test",
  slug: "villa-test-request",
  description: null,
  type: "MIXED" as const,
  status: "ACTIVE" as const,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  _count: { assets: 0, renderJobs: 0 },
};

describe("project validation", () => {
  it("normalizes valid input and rejects invalid names", () => {
    expect(
      createProjectSchema.parse({
        name: "  Villa Riverside  ",
        description: "  concept  ",
        requestId: "00000000-0000-4000-8000-000000000099",
      }),
    ).toMatchObject({ name: "Villa Riverside", description: "concept" });
    expect(() =>
      createProjectSchema.parse({ name: " ", requestId: crypto.randomUUID() }),
    ).toThrow();
  });

  it("bounds pagination and whitelists filters and sorting", () => {
    expect(() => listProjectsSchema.parse({ page: 0 })).toThrow();
    expect(() => listProjectsSchema.parse({ pageSize: 25 })).toThrow();
    expect(() => listProjectsSchema.parse({ sort: "ownerId" })).toThrow();
    expect(() => listProjectsSchema.parse({ status: "DELETED" })).toThrow();
  });
});

describe("ProjectService", () => {
  it("always scopes list queries to the authenticated principal", async () => {
    const findMany = vi.fn().mockResolvedValue([project]);
    const count = vi.fn().mockResolvedValue(1);
    const service = new ProjectService({ project: { findMany, count } } as unknown as PrismaClient);

    const result = await service.list(principal, { search: "Villa", status: "ACTIVE" });

    expect(result.total).toBe(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: principal.id }) }),
    );
  });

  it("rejects mutations from roles not allowed to manage projects", async () => {
    const service = new ProjectService({} as PrismaClient);
    await expect(
      service.create(
        { id: principal.id, role: "ADMIN" },
        { name: "Forbidden", requestId: crypto.randomUUID() },
      ),
    ).rejects.toThrow();
  });

  it("archives an active project and records the transition", async () => {
    const archived = { ...project, status: "ARCHIVED" as const, archivedAt: now };
    const findUnique = vi.fn().mockResolvedValueOnce(project).mockResolvedValueOnce(archived);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const activityCreate = vi.fn().mockResolvedValue({});
    const transaction = { project: { findUnique, updateMany }, activityLog: { create: activityCreate } };
    const database = { $transaction: (work: (value: unknown) => unknown) => work(transaction) } as unknown as PrismaClient;

    const result = await new ProjectService(database).archive(principal, project.id, {
      expectedUpdatedAt: now.toISOString(),
    });

    expect(result.status).toBe("ARCHIVED");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: principal.id }) }),
    );
    expect(activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "PROJECT_ARCHIVED" }) }),
    );
  });

  it("detects concurrent updates instead of overwriting them", async () => {
    const findUnique = vi.fn().mockResolvedValue(project);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = { project: { findUnique, updateMany }, activityLog: { create: vi.fn() } };
    const database = { $transaction: (work: (value: unknown) => unknown) => work(transaction) } as unknown as PrismaClient;

    await expect(
      new ProjectService(database).update(principal, project.id, {
        name: "Changed",
        description: "",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "PROJECT_CONFLICT" } satisfies Partial<ProjectApplicationError>);
  });
});
