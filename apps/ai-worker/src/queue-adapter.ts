import type { QueuePort, RuntimeClaim } from "@archrender/ai-engine";
import { WorkerQueueService } from "@archrender/jobs";

export class DatabaseQueueAdapter implements QueuePort {
  constructor(private readonly queue: WorkerQueueService) {}
  async claim(workerId: string): Promise<RuntimeClaim | null> {
    return await this.queue.claim(workerId);
  }
  start(claim: RuntimeClaim) { return this.queue.start(claim); }
  heartbeat(claim: RuntimeClaim, progress: number) { return this.queue.heartbeat(claim, progress); }
  succeed(claim: RuntimeClaim) { return this.queue.succeed(claim); }
  fail(claim: RuntimeClaim, code: string, retryable: boolean) { return this.queue.fail(claim, code, retryable); }
  acknowledgeCancel(claim: RuntimeClaim) { return this.queue.acknowledgeCancel(claim); }
  isCancelRequested(claim: RuntimeClaim) { return this.queue.isCancelRequested(claim); }
}
