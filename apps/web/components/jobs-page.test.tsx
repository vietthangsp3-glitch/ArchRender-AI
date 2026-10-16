import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobsPage } from "./jobs-page";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Job History", () => {
  it("renders a clear empty state when the owner has no render jobs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true, result: { items: [], total: 0, page: 1, pageSize: 20 } }));
    render(<JobsPage />);
    expect(screen.getByText("Đang tải lịch sử xử lý…")).toBeInTheDocument();
    expect(await screen.findByText("Chưa có lịch sử xử lý")).toBeInTheDocument();
    expect(screen.getByText("0 jobs · trang 1/1")).toBeInTheDocument();
  });

  it("renders owner-scoped jobs and nullable workflow data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true, result: { total: 1, page: 1, pageSize: 20, items: [{
      id: "11111111-1111-4111-8111-111111111111", type: "IMAGE_RENDER", status: "SUCCEEDED", progress: "100.00",
      retryCount: 0, maxRetries: 2, errorCode: null, createdAt: "2026-10-16T00:00:00.000Z",
      project: { id: "22222222-2222-4222-8222-222222222222", name: "Villa North" }, workflowVersion: null,
    }] } }));
    render(<JobsPage />);
    expect(await screen.findByText("Villa North")).toBeInTheDocument();
    expect(screen.getAllByText("SUCCEEDED")).toHaveLength(2);
    expect(screen.getByText("1 jobs · trang 1/1")).toBeInTheDocument();
  });

  it("leaves loading state and offers retry when the API returns an error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: false, code: "JOB_UNEXPECTED_ERROR" }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { items: [], total: 0, page: 1, pageSize: 20 } }));
    render(<JobsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("JOB_UNEXPECTED_ERROR · HTTP 500");
    expect(screen.queryByText("Đang tải lịch sử xử lý…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Thử lại/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Chưa có lịch sử xử lý")).toBeInTheDocument();
  });

  it("turns a rejected request into a recoverable network error instead of loading forever", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network unavailable"));
    render(<JobsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("JOB_NETWORK_ERROR");
    expect(screen.queryByText("Đang tải lịch sử xử lý…")).not.toBeInTheDocument();
    expect(screen.getByText(/Dữ liệu chưa được tải/)).toBeInTheDocument();
  });
});
