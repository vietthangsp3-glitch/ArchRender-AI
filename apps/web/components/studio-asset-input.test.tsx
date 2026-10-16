import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadAndVerifyAsset } = vi.hoisted(() => ({ uploadAndVerifyAsset: vi.fn() }));

vi.mock("@/lib/assets/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assets/upload")>();
  return { ...actual, uploadAndVerifyAsset };
});
vi.mock("./asset-picker", () => ({
  AssetPicker: ({ label }: { label: string }) => <div>library:{label}</div>,
}));

import { StudioAssetInput } from "./studio-asset-input";
import { AssetUploadFlowError } from "@/lib/assets/upload";

const project = { id: "11111111-1111-4111-8111-111111111111", status: "ACTIVE" as const };
const policy = {
  maxUploadBytes: 1024,
  acceptedContentTypes: ["image/png"],
  uploadAssetTypes: ["SOURCE_IMAGE", "REFERENCE_IMAGE", "DEPTH_MAP", "NORMAL_MAP", "CANNY_MAP"] as const,
};
const readyAsset = {
  id: "22222222-2222-4222-8222-222222222222",
  project: { ...project, name: "Test" },
  assetType: "SOURCE_IMAGE" as const,
  status: "READY" as const,
  originalName: "source.png",
  contentType: "image/png",
  byteSize: 3,
  width: 16,
  height: 16,
  uploadExpired: false,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  verifiedAt: "2026-10-16T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("Image Studio local upload", () => {
  it("uploads, verifies, and automatically selects a READY source image", async () => {
    uploadAndVerifyAsset.mockImplementation(async ({ onPhase, onProgress }) => {
      onPhase?.("uploading"); onProgress?.(60); onPhase?.("verifying"); onProgress?.(100); onPhase?.("success");
      return readyAsset;
    });
    const onChange = vi.fn();
    render(<StudioAssetInput label="Ảnh nguồn / tham chiếu" project={project} allowedTypes={["SOURCE_IMAGE", "REFERENCE_IMAGE"]} value={null} policy={policy} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Ảnh nguồn / tham chiếu"), {
      target: { files: [new File(["png"], "source.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(readyAsset));
    expect(uploadAndVerifyAsset).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, assetType: "SOURCE_IMAGE" }));
    expect(screen.getByText(/Đã xác minh READY/)).toBeInTheDocument();
  });

  it("maps a control-map upload to the exact requested asset type", async () => {
    const depth = { ...readyAsset, assetType: "DEPTH_MAP" as const };
    uploadAndVerifyAsset.mockResolvedValue(depth);
    render(<StudioAssetInput label="Depth Map" project={project} allowedTypes={["DEPTH_MAP"]} value={null} policy={policy} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Depth Map"), {
      target: { files: [new File(["png"], "depth.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(uploadAndVerifyAsset).toHaveBeenCalledWith(expect.objectContaining({ assetType: "DEPTH_MAP", projectId: project.id })));
  });

  it("guards archived projects and provides a retry path after failure", async () => {
    const { rerender } = render(<StudioAssetInput label="Ảnh nguồn" project={{ ...project, status: "ARCHIVED" }} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Tải từ máy/ })).toBeDisabled();
    expect(screen.getByText(/Dự án đã lưu trữ/)).toBeInTheDocument();

    uploadAndVerifyAsset.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(readyAsset);
    rerender(<StudioAssetInput label="Ảnh nguồn" project={project} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Ảnh nguồn"), {
      target: { files: [new File(["png"], "source.png", { type: "image/png" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Tải trực tiếp thất bại");
    fireEvent.click(screen.getByRole("button", { name: /Thử lại/ }));
    await waitFor(() => expect(uploadAndVerifyAsset).toHaveBeenCalledTimes(2));
  });

  it("shows only a sanitized stage, code, and status for an initiate failure", async () => {
    uploadAndVerifyAsset.mockRejectedValue(new AssetUploadFlowError("initiate", "ASSET_INVALID_ORIGIN", 403));
    render(<StudioAssetInput label="Ảnh nguồn" project={project} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Ảnh nguồn"), {
      target: { files: [new File(["png"], "source.png", { type: "image/png" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("stage=initiate · code=ASSET_INVALID_ORIGIN · http=403");
    expect(screen.getByRole("alert")).not.toHaveTextContent("signed");
  });

  it("uses a fresh idempotency key when upload B follows a failed PUT for upload A", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    uploadAndVerifyAsset
      .mockRejectedValueOnce(new AssetUploadFlowError("put", "DIRECT_UPLOAD_HTTP_ERROR", 403))
      .mockResolvedValueOnce({ ...readyAsset, originalName: "b.png" });
    render(<StudioAssetInput label="Ảnh nguồn" project={project} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    const picker = screen.getByLabelText("Tệp tải lên cho Ảnh nguồn");

    fireEvent.change(picker, { target: { files: [new File(["aaa"], "a.png", { type: "image/png" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_UPLOAD_HTTP_ERROR");
    fireEvent.change(picker, { target: { files: [new File(["bbb"], "b.png", { type: "image/png" })] } });
    await waitFor(() => expect(uploadAndVerifyAsset).toHaveBeenCalledTimes(2));

    expect(uploadAndVerifyAsset.mock.calls[0]?.[0].requestId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(uploadAndVerifyAsset.mock.calls[1]?.[0].requestId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("reuses one idempotency key for same-file retry and suppresses repeated retry clicks", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let resolveRetry: ((asset: typeof readyAsset) => void) | undefined;
    uploadAndVerifyAsset
      .mockRejectedValueOnce(new AssetUploadFlowError("put", "DIRECT_UPLOAD_NETWORK_ERROR"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    render(<StudioAssetInput label="Ảnh nguồn" project={project} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Ảnh nguồn"), {
      target: { files: [new File(["png"], "same.png", { type: "image/png" })] },
    });
    const retry = await screen.findByRole("button", { name: /Thử lại/ });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(uploadAndVerifyAsset).toHaveBeenCalledTimes(2);
    expect(uploadAndVerifyAsset.mock.calls[0]?.[0].requestId).toBe(uploadAndVerifyAsset.mock.calls[1]?.[0].requestId);
    resolveRetry?.(readyAsset);
  });

  it("keeps the same operation after cancel, but creates a new key after remount", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    uploadAndVerifyAsset.mockImplementationOnce(({ signal, onPhase }) => {
      onPhase?.("uploading");
      return new Promise((_resolve, reject) => signal?.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      ));
    }).mockResolvedValue(readyAsset);
    const view = render(<StudioAssetInput label="Ảnh nguồn" project={project} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Ảnh nguồn"), {
      target: { files: [new File(["png"], "same.png", { type: "image/png" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Hủy tải lên/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Thử lại/ }));
    await waitFor(() => expect(uploadAndVerifyAsset).toHaveBeenCalledTimes(2));
    expect(uploadAndVerifyAsset.mock.calls[0]?.[0].requestId).toBe(uploadAndVerifyAsset.mock.calls[1]?.[0].requestId);

    view.unmount();
    render(<StudioAssetInput label="Ảnh nguồn" project={project} allowedTypes={["SOURCE_IMAGE"]} value={null} policy={policy} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tệp tải lên cho Ảnh nguồn"), {
      target: { files: [new File(["png"], "same.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(uploadAndVerifyAsset).toHaveBeenCalledTimes(3));
    expect(uploadAndVerifyAsset.mock.calls[2]?.[0].requestId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
