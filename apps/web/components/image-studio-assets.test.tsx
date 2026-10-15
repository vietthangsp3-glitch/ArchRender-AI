import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("Image Studio asset integration", () => {
  it("resets project-scoped selections when the project changes", () => {
    render(<ImageStudio projectOptions={[
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
    render(<ImageStudio projectOptions={[{ id: "archived", name: "Archived", status: "ARCHIVED" }]} />);
    fireEvent.change(screen.getByRole("combobox", { name: /Dự án liên kết/ }), { target: { value: "archived" } });
    expect(screen.getByRole("button", { name: /Dự án chỉ đọc/ })).toBeDisabled();
  });
});
