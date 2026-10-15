import { createHash } from "node:crypto";

import { AssetApplicationError, type CompletionPhase, StorageError } from "./errors";
import type { StorageProvider } from "./storage-provider";
import type { StorageObjectKey } from "./types";

function normalizeEtag(etag: string | null | undefined): string | null {
  return etag?.trim().replace(/^"|"$/g, "") || null;
}

export interface FinalizeImmutableObjectInput {
  assetId: string;
  finalKey: StorageObjectKey;
  bytes: Uint8Array;
  contentType: string;
  checksumSha256: string;
  role?: string;
}

export class ImmutableObjectFinalizer {
  constructor(
    private readonly storage: StorageProvider,
    private readonly maxBytes: number,
  ) {}

  async finalize(
    input: FinalizeImmutableObjectInput,
    onPhase?: (phase: Extract<CompletionPhase, "final_put" | "final_readback">) => void,
  ): Promise<{ etag: string }> {
    if (input.bytes.byteLength <= 0 || input.bytes.byteLength > this.maxBytes) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Final object size is invalid.");
    }
    const actualChecksum = createHash("sha256").update(input.bytes).digest("hex");
    if (actualChecksum !== input.checksumSha256) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Final object checksum is invalid.");
    }
    try {
      onPhase?.("final_put");
      const role = input.role ?? "original";
      await this.storage.createImmutableObject({
        key: input.finalKey,
        bytes: input.bytes,
        contentType: input.contentType,
        metadata: {
          assetId: input.assetId,
          role,
          sha256: input.checksumSha256,
        },
      });
    } catch (error) {
      if (!(error instanceof StorageError && error.code === "PRECONDITION_FAILED")) throw error;
    }
    onPhase?.("final_readback");
    return this.verify(input);
  }

  private async verify(input: FinalizeImmutableObjectInput): Promise<{ etag: string }> {
    const role = input.role ?? "original";
    const head = await this.storage.headObject(input.finalKey);
    const conditionalEtag = head.etag?.trim() || null;
    const etag = normalizeEtag(head.etag);
    const metadataAssetId = head.metadata["assetid"] ?? head.metadata["assetId"];
    if (
      !conditionalEtag || !etag || head.contentLength !== input.bytes.byteLength ||
      head.contentType !== input.contentType || metadataAssetId !== input.assetId ||
      head.metadata["role"] !== role || head.metadata["sha256"] !== input.checksumSha256
    ) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Final object metadata does not match.");
    }
    const stored = await this.storage.readObject(input.finalKey, this.maxBytes, { ifMatch: conditionalEtag });
    const storedChecksum = createHash("sha256").update(stored.bytes).digest("hex");
    if (stored.bytes.byteLength !== input.bytes.byteLength || storedChecksum !== input.checksumSha256) {
      throw new AssetApplicationError("ASSET_INTEGRITY_CONFLICT", "Final object checksum does not match.");
    }
    return { etag };
  }
}
