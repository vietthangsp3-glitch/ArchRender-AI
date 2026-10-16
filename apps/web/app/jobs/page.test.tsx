import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/projects/server", () => ({
  getProjectService: () => ({ list: mocks.listProjects }),
}));
vi.mock("@/components/jobs-page", () => ({ JobsPage: () => null }));

import Page from "./page";

describe("Job History page", () => {
  it("uses a project page size accepted by the ProjectService contract", async () => {
    const principal = { id: "00000000-0000-4000-8000-000000000001", role: "OWNER" };
    mocks.requirePageSession.mockResolvedValue(principal);
    mocks.listProjects.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24, pageCount: 1 });

    await Page();

    expect(mocks.listProjects).toHaveBeenCalledWith(principal, {
      status: "ALL",
      sort: "name",
      direction: "asc",
      page: 1,
      pageSize: 24,
    });
  });
});
