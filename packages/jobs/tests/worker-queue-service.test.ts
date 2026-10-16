import { describe, expect, it, vi } from "vitest";

import { JobApplicationError, WorkerQueueService } from "../src/index.js";

const claim = {
  jobId: "00000000-0000-4000-8000-000000000001",
  generation: 2,
  leaseToken: "test-lease-token",
};

describe("worker lease and fencing", () => {
  it("rejects invalid progress before touching persistence", async () => {
    const database = { renderJob: { updateMany: vi.fn() } };
    const queue = new WorkerQueueService(database as never);
    await expect(queue.heartbeat(claim, 101)).rejects.toMatchObject({ code: "JOB_INVALID_INPUT" });
    expect(database.renderJob.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an invalid exact-job claim scope before touching persistence", async () => {
    const database = { $transaction: vi.fn() };
    const queue = new WorkerQueueService(database as never);
    await expect(queue.claim("worker_test", 60, { jobId: "not-a-uuid" })).rejects.toMatchObject({ code: "JOB_INVALID_INPUT" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a stale heartbeat using generation and token fencing", async () => {
    const database = {
      renderJob: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      renderJobAttempt: { updateMany: vi.fn() },
    };
    const queue = new WorkerQueueService(database as never);
    await expect(queue.heartbeat(claim, 50)).rejects.toMatchObject({ code: "JOB_STALE_WORKER" });
    expect(database.renderJobAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("accepts a bounded heartbeat and never persists the raw lease token", async () => {
    const database = {
      renderJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      renderJobAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const queue = new WorkerQueueService(database as never, () => new Date("2026-10-15T00:00:00.000Z"));
    await queue.heartbeat(claim, 50, 60);
    const serialized = JSON.stringify([
      database.renderJob.updateMany.mock.calls,
      database.renderJobAttempt.updateMany.mock.calls,
    ]);
    expect(serialized).not.toContain(claim.leaseToken);
    expect(serialized).toContain("50");
  });

  it("fails closed when a stale worker tries to complete", async () => {
    const transaction = { renderJob: { findUnique: vi.fn().mockResolvedValue(null) } };
    const database = { $transaction: vi.fn((callback) => callback(transaction)) };
    const queue = new WorkerQueueService(database as never);
    await expect(queue.succeed(claim)).rejects.toBeInstanceOf(JobApplicationError);
  });
});
