import { describe, expect, it, vi } from "vitest";

import { EngineGatewayClient } from "../src";

describe("private gateway client", () => {
  it("uses worker auth and validates safe responses", async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${"x".repeat(32)}` });
      return new Response(JSON.stringify({ executionId: "5d93ec65-2de8-451c-bbf8-b37854af763c" }), { status: 200 });
    });
    const client = new EngineGatewayClient({ baseUrl: "http://ai-gateway:8080", serviceToken: "x".repeat(32), timeoutMs: 1000, fetch: request as typeof fetch });
    await expect(client.submit({ requestId: "request", jobId: "job", generation: 1, prompt: {} })).resolves.toMatch(/^[0-9a-f-]+$/);
  });

  it("refuses insecure remote transport", () => {
    expect(() => new EngineGatewayClient({ baseUrl: "http://remote.example", serviceToken: "x".repeat(32), timeoutMs: 1000 })).toThrow(/HTTPS/);
  });
});
