import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetClientError, listAssets } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("typed asset client", () => {
  it("serializes only bounded server-side list filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { items: [], total: 0, page: 2, pageSize: 12, pageCount: 1, policy: {} },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await listAssets({ projectId: "project", status: "READY", search: "villa", page: 2, pageSize: 12 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets?projectId=project&status=READY&search=villa&page=2&pageSize=12",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("maps safe API codes without exposing backend response text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, code: "ASSET_INTEGRITY_CONFLICT", detail: "must not escape",
    }), { status: 503 })));
    await expect(listAssets({})).rejects.toEqual(expect.objectContaining<Partial<AssetClientError>>({
      code: "ASSET_INTEGRITY_CONFLICT",
      status: 503,
    }));
  });
});
