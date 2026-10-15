import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { listAssets } = vi.hoisted(() => ({ listAssets: vi.fn() }));

vi.mock("@/lib/assets/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assets/client")>();
  return { ...actual, listAssets };
});

vi.mock("./asset-preview", () => ({
  AssetPreview: ({ alt }: { alt: string }) => <div aria-label={alt} />,
}));

import { AssetPicker } from "./asset-picker";

const projectId = "11111111-1111-4111-8111-111111111111";
const result = {
  items: [{
    id: "22222222-2222-4222-8222-222222222222",
    project: { id: projectId, name: "Test project", status: "ACTIVE" as const },
    assetType: "SOURCE_IMAGE" as const,
    status: "READY" as const,
    originalName: "facade.png",
    contentType: "image/png",
    byteSize: 128,
    width: 32,
    height: 24,
    uploadExpired: false,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    verifiedAt: "2026-10-14T00:00:00.000Z",
  }],
  total: 13,
  page: 1,
  pageSize: 12,
  pageCount: 2,
  policy: { maxUploadBytes: 1024, acceptedContentTypes: ["image/png"], uploadAssetTypes: ["SOURCE_IMAGE"] },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("asset picker", () => {
  it("uses an accessible dialog and keeps project, READY, type, search, and page filters server-side", async () => {
    listAssets.mockResolvedValue(result);
    render(
      <AssetPicker
        label="Ảnh nguồn"
        projectId={projectId}
        allowedTypes={["SOURCE_IMAGE", "REFERENCE_IMAGE"]}
        value={null}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chọn từ thư viện" }));
    expect(screen.getByRole("dialog", { name: "Ảnh nguồn" })).toBeInTheDocument();
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        assetType: "SOURCE_IMAGE",
        status: "READY",
        search: "",
        page: 1,
        pageSize: 12,
      }),
      expect.any(AbortSignal),
    ));

    fireEvent.change(screen.getByLabelText("Loại tài nguyên"), { target: { value: "REFERENCE_IMAGE" } });
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, assetType: "REFERENCE_IMAGE", status: "READY" }),
      expect.any(AbortSignal),
    ));

    fireEvent.change(screen.getByLabelText("Tìm tài nguyên"), { target: { value: "facade" } });
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, search: "facade", page: 1 }),
      expect.any(AbortSignal),
    ), { timeout: 1_000 });

    fireEvent.click(screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-chevron-right"))!);
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, status: "READY", page: 2 }),
      expect.any(AbortSignal),
    ));
  });
});
