import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRequestSession: vi.fn(), list: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.getRequestSession }));
vi.mock("@/lib/jobs/server", () => ({ getRenderJobService: () => ({ list: mocks.list, submit: mocks.submit }) }));

import { GET, POST } from "./route";

const principal = { id: "00000000-0000-4000-8000-000000000001", role: "OWNER" };
const payload = {
  idempotencyKey: "request_0000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  workflowVersionId: "00000000-0000-4000-8000-000000000003",
  type: "IMAGE_RENDER",
  inputs: [{ assetId: "00000000-0000-4000-8000-000000000004", role: "SOURCE_IMAGE", position: 0 }],
  parameters: { prompt: "house", width: 1024, height: 768 },
};
function request(origin = "http://localhost:3000", body: unknown = payload) {
  return new Request("http://localhost:3000/api/render-jobs", { method: "POST", headers: { host: "localhost:3000", origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("/api/render-jobs", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getRequestSession.mockResolvedValue(principal); });

  it("rejects cross-origin submission before session and persistence", async () => {
    const response = await POST(request("https://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(mocks.getRequestSession).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("requires authentication for list and submit", async () => {
    mocks.getRequestSession.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost:3000/api/render-jobs"))).status).toBe(401);
    expect((await POST(request())).status).toBe(401);
  });

  it("passes only the authenticated principal and parsed JSON to the service", async () => {
    mocks.submit.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000005", status: "QUEUED" });
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.submit).toHaveBeenCalledWith(principal, payload);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects oversized bodies without invoking the service", async () => {
    const oversized = request("http://localhost:3000", { payload: "x".repeat(33_000) });
    const response = await POST(oversized);
    expect(response.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
