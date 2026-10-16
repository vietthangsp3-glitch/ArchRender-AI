import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.getRequestSession }));
vi.mock("@/lib/jobs/server", () => ({ getWorkflowService: () => mocks }));

import { GET as listWorkflows, POST as createWorkflow } from "./route";
import { GET as getWorkflow, PATCH as updateWorkflow } from "./[workflowId]/route";
import { POST as publishWorkflow } from "./[workflowId]/publish/route";

const principal = { id: "00000000-0000-4000-8000-000000000001", role: "OWNER" };
const workflowId = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ workflowId }) };
const configuration = { backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", modelFamily: "sdxl", parameterSchemaVersion: "1", conditioning: ["IMAGE"] };

function mutation(path: string, method: "POST" | "PATCH", body?: unknown, origin = "http://localhost:3000") {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { host: "localhost:3000", origin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("workflow API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequestSession.mockResolvedValue(principal);
  });

  it("lists and reads workflows only through the authenticated principal", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ id: workflowId });
    expect((await listWorkflows(new Request("http://localhost:3000/api/workflows?kind=IMAGE_RENDER&status=PUBLISHED"))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(principal, { kind: "IMAGE_RENDER", status: "PUBLISHED" });
    expect((await getWorkflow(new Request(`http://localhost:3000/api/workflows/${workflowId}`), context)).status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(principal, workflowId);
  });

  it("rejects an untrusted create before authentication or persistence", async () => {
    const response = await createWorkflow(mutation("/api/workflows", "POST", { name: "Unsafe", kind: "IMAGE_RENDER", configuration }, "https://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(mocks.getRequestSession).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes create, update, and publish through the workflow service", async () => {
    const createInput = { name: "Architecture", kind: "IMAGE_RENDER", configuration };
    mocks.create.mockResolvedValue({ id: workflowId });
    mocks.update.mockResolvedValue({ id: workflowId });
    mocks.publish.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000003" });

    expect((await createWorkflow(mutation("/api/workflows", "POST", createInput))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(principal, createInput);
    const updateInput = { name: "Architecture v2", configuration };
    expect((await updateWorkflow(mutation(`/api/workflows/${workflowId}`, "PATCH", updateInput), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(principal, workflowId, updateInput);
    expect((await publishWorkflow(mutation(`/api/workflows/${workflowId}/publish`, "POST"), context)).status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith(principal, workflowId);
  });

  it("requires a session for reads and mutations", async () => {
    mocks.getRequestSession.mockResolvedValue(null);
    expect((await listWorkflows(new Request("http://localhost:3000/api/workflows"))).status).toBe(401);
    expect((await createWorkflow(mutation("/api/workflows", "POST", { name: "Draft", kind: "IMAGE_RENDER", configuration }))).status).toBe(401);
  });
});
