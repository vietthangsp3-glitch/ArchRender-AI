import { describe, expect, it, vi } from "vitest";

import { DatabaseQueueAdapter } from "../src/queue-adapter";

describe("database queue adapter", () => {
  it("does not reinterpret cancellation state", async () => {
    const queue = { isCancelRequested: vi.fn(async () => true) };
    const adapter = new DatabaseQueueAdapter(queue as never);
    const claim = { jobId: "job", generation: 1, leaseToken: "token" } as never;
    await expect(adapter.isCancelRequested(claim)).resolves.toBe(true);
    expect(queue.isCancelRequested).toHaveBeenCalledWith(claim);
  });
});
