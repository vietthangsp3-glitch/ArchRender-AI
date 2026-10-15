import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.getRequestSession }));
vi.mock("@/lib/projects/server", () => ({
  getProjectService: () => ({ list: mocks.list, create: mocks.create }),
}));

import { GET, POST } from "./route";

const principal = { id: "00000000-0000-4000-8000-000000000001", role: "OWNER" };

function postRequest(origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { host: "localhost:3000", origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Test project", requestId: crypto.randomUUID() }),
  });
}

describe("/api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue(principal);
  });

  it("rejects cross-origin mutations before session or service work", async () => {
    const response = await POST(postRequest("http://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(mocks.getRequestSession).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires a server-validated session for reads and mutations", async () => {
    mocks.getRequestSession.mockResolvedValue(null);
    const read = await GET(new Request("http://localhost:3000/api/projects"));
    const write = await POST(postRequest());
    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes the authenticated principal to the application service", async () => {
    mocks.create.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000010" });
    const response = await POST(postRequest());
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(principal, expect.objectContaining({ name: "Test project" }));
  });
});
