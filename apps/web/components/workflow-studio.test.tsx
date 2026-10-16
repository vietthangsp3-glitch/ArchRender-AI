import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowStudio } from "./workflow-studio";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workflow Studio web contract", () => {
  it("creates schema-valid lowercase workflow defaults", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true, workflow: { id: "workflow-1", name: request.name, kind: request.kind, status: "DRAFT", currentVersionNumber: 0, draftConfiguration: request.configuration, versions: [] } }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true, workflows: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkflowStudio />);
    fireEvent.click(screen.getByRole("button", { name: /Tạo draft/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/workflows", expect.objectContaining({ method: "POST" })));
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    const payload = JSON.parse(String(createCall[1]?.body));
    expect(payload.configuration.modelFamily).toBe("sdxl");
    expect(payload.configuration.modelFamily).toMatch(/^[a-z0-9][a-z0-9_-]+$/);
  });

  it("publishes the selected draft through the protected API path", async () => {
    const workflow = { id: "workflow-1", name: "Architecture", kind: "IMAGE_RENDER", status: "DRAFT", currentVersionNumber: 0, draftConfiguration: { backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1", modelFamily: "sdxl", conditioning: ["IMAGE"] }, versions: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/publish")) return new Response(JSON.stringify({ ok: true, version: { id: "version-1", version: 1 } }));
      return new Response(JSON.stringify({ ok: true, workflows: [workflow] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkflowStudio />);
    await screen.findByDisplayValue("Architecture");
    fireEvent.click(screen.getByRole("button", { name: /Publish version/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/workflows/workflow-1/publish", expect.objectContaining({ method: "POST" })));
  });
});
