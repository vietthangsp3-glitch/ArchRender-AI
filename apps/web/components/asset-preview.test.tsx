import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getAssetThumbnailUrl } = vi.hoisted(() => ({ getAssetThumbnailUrl: vi.fn() }));
vi.mock("@/lib/assets/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assets/client")>();
  return { ...actual, getAssetThumbnailUrl };
});

import { AssetPreview } from "./asset-preview";
import { AssetClientError } from "@/lib/assets/client";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("private asset preview", () => {
  it("refreshes an expired signed URL once without an infinite loop", async () => {
    getAssetThumbnailUrl
      .mockResolvedValueOnce({ assetId: "asset", url: "https://signed.invalid/one", expiresAt: "2020-01-01T00:00:00.000Z" })
      .mockResolvedValueOnce({ assetId: "asset", url: "https://signed.invalid/two", expiresAt: "2030-01-01T00:00:00.000Z" });
    render(<AssetPreview assetId="asset" status="READY" alt="Private preview" eager />);
    const first = await screen.findByAltText("Private preview");
    fireEvent.error(first);
    await waitFor(() => expect(getAssetThumbnailUrl).toHaveBeenCalledTimes(2));
    expect(getAssetThumbnailUrl).toHaveBeenCalledWith("asset", "detail", expect.any(AbortSignal));
    expect(await screen.findByAltText("Private preview")).toHaveAttribute("src", "https://signed.invalid/two");
  });

  it("shows a safe integrity error instead of a broken image", async () => {
    getAssetThumbnailUrl.mockRejectedValue(new AssetClientError("ASSET_INTEGRITY_CONFLICT", 503));
    render(<AssetPreview assetId="asset" status="READY" alt="Private preview" eager />);
    expect(await screen.findByText(/Tệp đã thay đổi/)).toBeInTheDocument();
  });

  it("requests a GRID derivative for lazy library previews", async () => {
    getAssetThumbnailUrl.mockResolvedValue({ assetId: "asset", url: "https://signed.invalid/grid", expiresAt: "2030-01-01T00:00:00.000Z" });
    render(<AssetPreview assetId="asset" status="READY" alt="Grid preview" />);
    expect(await screen.findByAltText("Grid preview")).toHaveAttribute("src", "https://signed.invalid/grid");
    expect(getAssetThumbnailUrl).toHaveBeenCalledWith("asset", "grid", expect.any(AbortSignal));
  });
});
