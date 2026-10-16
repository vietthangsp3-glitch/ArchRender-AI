import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const readyAsset = {
  id: "00000000-0000-4000-8000-000000000010",
  project: { id: "00000000-0000-4000-8000-000000000020", name: "Active", status: "ACTIVE" },
  assetType: "SOURCE_IMAGE",
  status: "READY",
  originalName: "source.png",
  contentType: "image/png",
  byteSize: 10,
  width: 10,
  height: 10,
  uploadExpired: false,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  verifiedAt: "2026-10-14T00:00:00.000Z",
} as const;

vi.mock("./asset-picker", () => ({
  AssetPicker: ({ label, value, onChange }: { label: string; value: typeof readyAsset | null; onChange: (asset: typeof readyAsset) => void }) => (
    <div data-testid={`picker-${label}`}>
      <span>{value?.id ?? "empty"}</span>
      <button onClick={() => onChange(readyAsset)}>select {label}</button>
    </div>
  ),
}));
vi.mock("./asset-preview", () => ({ AssetPreview: () => <div data-testid="asset-preview" /> }));

import { ImageStudio } from "./image-studio";

const uploadPolicy = {
  maxUploadBytes: 25 * 1024 * 1024,
  acceptedContentTypes: ["image/jpeg", "image/png", "image/webp"],
  uploadAssetTypes: ["SOURCE_IMAGE", "REFERENCE_IMAGE", "DEPTH_MAP", "NORMAL_MAP", "CANNY_MAP"] as const,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true, job: { id: "job-1", status: "QUEUED" } }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true, workflows: [{ id: "workflow", name: "SDXL", versions: [{ id: "00000000-0000-4000-8000-000000000030", version: 1 }] }] }));
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("Image Studio asset integration", () => {
  it("resets project-scoped selections when the project changes", () => {
    render(<ImageStudio uploadPolicy={uploadPolicy} projectOptions={[
      { id: "active", name: "Active", status: "ACTIVE" },
      { id: "other", name: "Other", status: "ACTIVE" },
    ]} />);
    const project = screen.getByRole("combobox", { name: /Dự án liên kết/ });
    fireEvent.change(project, { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "select Ảnh nguồn / tham chiếu" }));
    expect(screen.getByTestId("picker-Ảnh nguồn / tham chiếu")).toHaveTextContent(readyAsset.id);
    fireEvent.change(project, { target: { value: "other" } });
    expect(screen.getByTestId("picker-Ảnh nguồn / tham chiếu")).toHaveTextContent("empty");
  });

  it("keeps archived projects read-only", () => {
    render(<ImageStudio uploadPolicy={uploadPolicy} projectOptions={[{ id: "archived", name: "Archived", status: "ARCHIVED" }]} />);
    fireEvent.change(screen.getByRole("combobox", { name: /Dự án liên kết/ }), { target: { value: "archived" } });
    expect(screen.getByRole("button", { name: /Dự án chỉ đọc/ })).toBeDisabled();
  });

  it("loads a published workflow and submits a queued job with the selected asset", async () => {
    render(<ImageStudio uploadPolicy={uploadPolicy} projectOptions={[{ id: "active", name: "Active", status: "ACTIVE" }]} />);
    fireEvent.change(screen.getByRole("combobox", { name: /Dự án liên kết/ }), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "select Ảnh nguồn / tham chiếu" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Published workflow" })).toHaveValue("00000000-0000-4000-8000-000000000030"));
    fireEvent.click(screen.getByRole("button", { name: /Xếp hàng Render/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/render-jobs", expect.objectContaining({ method: "POST" })));
    const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === "/api/render-jobs" && init?.method === "POST")!;
    const payload = JSON.parse(String(call[1]?.body));
    expect(payload).toMatchObject({ projectId: "active", workflowVersionId: "00000000-0000-4000-8000-000000000030", type: "IMAGE_RENDER" });
    expect(payload.inputs).toEqual([{ assetId: readyAsset.id, role: "SOURCE_IMAGE", position: 0 }]);
    expect(await screen.findByRole("status")).toHaveTextContent("QUEUED");
  });
});
