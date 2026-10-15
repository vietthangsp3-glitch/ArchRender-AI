import type { OutputCommitter } from "@archrender/ai-engine";
import { GeneratedOutputService } from "@archrender/assets";

export class ImmutableOutputCommitter implements OutputCommitter {
  constructor(private readonly outputs: GeneratedOutputService) {}
  async commit(input: Parameters<OutputCommitter["commit"]>[0]) {
    await this.outputs.commit({
      ownerId: input.claim.ownerId,
      projectId: input.claim.projectId,
      jobId: input.claim.jobId,
      generation: input.claim.generation,
      leaseToken: input.claim.leaseToken,
      role: input.contentType === "video/mp4" ? "GENERATED_VIDEO" : "GENERATED_IMAGE",
      position: input.position,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
    });
  }
}
