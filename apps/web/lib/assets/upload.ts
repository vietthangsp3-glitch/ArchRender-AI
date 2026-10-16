import {
  AssetClientError,
  completeAssetUpload,
  getAsset,
  initiateAssetUpload,
  type AssetSummary,
  type UploadAssetType,
} from "./client";
import { uploadDirectlyToStorage } from "./direct-upload";

export type UploadPhase =
  | "idle"
  | "initiating"
  | "uploading"
  | "verifying"
  | "success"
  | "cancelled"
  | "error";

export interface UploadValidationPolicy {
  maxUploadBytes: number;
  acceptedContentTypes: readonly string[];
  uploadAssetTypes: readonly UploadAssetType[];
}

export function validateUploadFile(file: File, policy: UploadValidationPolicy): string | null {
  if (!policy.acceptedContentTypes.includes(file.type)) return "Chỉ hỗ trợ JPG, PNG hoặc WebP.";
  if (file.size <= 0) return "Tệp không được để trống.";
  if (file.size > policy.maxUploadBytes) {
    return `Tệp vượt quá giới hạn ${Math.floor(policy.maxUploadBytes / 1024 / 1024)} MB.`;
  }
  return null;
}

async function checksumSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadAndVerifyAsset(input: {
  requestId: string;
  projectId: string;
  assetType: UploadAssetType;
  file: File;
  policy: UploadValidationPolicy;
  signal?: AbortSignal;
  onPhase?: (phase: UploadPhase) => void;
  onProgress?: (percent: number) => void;
}): Promise<AssetSummary> {
  const problem = validateUploadFile(input.file, input.policy);
  if (problem) throw new AssetClientError("ASSET_INVALID_INPUT", 400);
  if (!input.policy.uploadAssetTypes.includes(input.assetType)) {
    throw new AssetClientError("ASSET_INVALID_INPUT", 400);
  }

  input.onPhase?.("initiating");
  const contract = await initiateAssetUpload({
    requestId: input.requestId,
    projectId: input.projectId,
    assetType: input.assetType,
    originalName: input.file.name,
    contentType: input.file.type,
    byteSize: input.file.size,
  }, input.signal);
  if (input.signal?.aborted) throw new DOMException("Upload aborted.", "AbortError");

  input.onPhase?.("uploading");
  const uploaded = await uploadDirectlyToStorage({
    url: contract.upload.url,
    requiredHeaders: contract.upload.requiredHeaders,
    file: input.file,
    ...(input.signal ? { signal: input.signal } : {}),
    timeoutMs: 120_000,
    onProgress: (loaded, total) => {
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      input.onProgress?.(percent);
    },
  });

  input.onPhase?.("verifying");
  const checksum = await checksumSha256(input.file);
  const completed = await completeAssetUpload(contract.assetId, {
    ...(uploaded.etag ? { etag: uploaded.etag } : {}),
    checksumSha256: checksum,
  }, input.signal);
  if (completed.assetId !== contract.assetId || completed.status !== "READY") {
    throw new AssetClientError("ASSET_VERIFICATION_FAILED", 422);
  }
  const asset = await getAsset(contract.assetId, input.signal);
  if (asset.id !== contract.assetId || asset.status !== "READY" || asset.project?.id !== input.projectId || asset.assetType !== input.assetType) {
    throw new AssetClientError("ASSET_INTEGRITY_CONFLICT", 503);
  }
  input.onProgress?.(100);
  input.onPhase?.("success");
  return asset;
}
