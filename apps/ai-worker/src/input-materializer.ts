import { createHash } from "node:crypto";
import type { InputMaterializer, RuntimeClaim } from "@archrender/ai-engine";
import { EngineGatewayClient } from "@archrender/ai-engine";
import type { PrismaClient } from "@archrender/database";
import type { StorageProvider, StorageObjectKey } from "@archrender/assets";
import { z } from "zod";

const snapshotSchema = z.array(z.object({
  assetId: z.string().uuid(), role: z.enum(["SOURCE_IMAGE", "START_FRAME", "CONTROL_IMAGE"]), position: z.number().int().min(0).max(32),
  storageObjectId: z.string().uuid(), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/), storageEtag: z.string().min(1).max(512),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict()).min(1).max(8);

export class VerifiedInputMaterializer implements InputMaterializer {
  private readonly staged = new Map<string, Array<{ workspaceId: string; filename: string; checksum: string }>>();
  constructor(private readonly database: PrismaClient, private readonly storage: StorageProvider, private readonly gateway: EngineGatewayClient, private readonly maxBytes: number) {}

  async materialize(claim: RuntimeClaim): Promise<Readonly<Record<string, string>>> {
    const snapshots = snapshotSchema.parse(claim.inputSnapshot);
    const workspaceId = createHash("sha256").update(`${claim.jobId}:${claim.generation}`).digest("hex");
    const staged: Array<{ workspaceId: string; filename: string; checksum: string }> = [];
    this.staged.set(claim.jobId, staged);
    const files: Record<string, string> = {};
    try {
      for (const snapshot of snapshots) {
        const object = await this.database.assetStorageObject.findUnique({
          where: { id_assetId_ownerId: { id: snapshot.storageObjectId, assetId: snapshot.assetId, ownerId: claim.ownerId } },
        });
        if (!object || object.role !== "ORIGINAL" || object.state !== "VERIFIED" || object.checksumSha256 !== snapshot.checksumSha256 ||
            object.storageEtag !== snapshot.storageEtag || object.contentType !== snapshot.contentType || object.deletedAt) {
          throw new Error("INPUT_IMMUTABLE_IDENTITY_MISMATCH");
        }
        const stored = await this.storage.readObject(object.objectKey as StorageObjectKey, this.maxBytes, { ifMatch: object.storageEtag });
        const checksum = createHash("sha256").update(stored.bytes).digest("hex");
        if (checksum !== snapshot.checksumSha256 || stored.bytes.byteLength !== Number(object.byteSize)) throw new Error("INPUT_CHECKSUM_MISMATCH");
        const extension = snapshot.contentType === "image/jpeg" ? "jpg" : snapshot.contentType.split("/")[1];
        const logicalName = snapshot.role === "SOURCE_IMAGE" ? "source" : snapshot.role === "START_FRAME" ? "start_frame" : `control_${snapshot.position}`;
        const filename = `${logicalName}.${extension}`;
        const stagedFilename = await this.gateway.stageInput(workspaceId, filename, stored.bytes, checksum);
        staged.push({ workspaceId, filename, checksum });
        files[logicalName] = stagedFilename;
      }
      return files;
    } catch (error) {
      await this.cleanup(claim);
      throw error;
    }
  }

  async cleanup(claim: RuntimeClaim): Promise<void> {
    const entries = this.staged.get(claim.jobId);
    if (!entries) return;
    for (const entry of entries) await this.gateway.deleteInput(entry.workspaceId, entry.filename, entry.checksum);
    this.staged.delete(claim.jobId);
  }
}
