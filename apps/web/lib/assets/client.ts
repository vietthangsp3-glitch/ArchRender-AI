export const ASSET_TYPES = [
  "SOURCE_IMAGE",
  "REFERENCE_IMAGE",
  "SOURCE_RENDER",
  "DEPTH_MAP",
  "NORMAL_MAP",
  "CANNY_MAP",
  "GENERATED_IMAGE",
  "GENERATED_VIDEO",
  "WORKFLOW_FILE",
] as const;

export const UPLOAD_ASSET_TYPES = [
  "SOURCE_IMAGE",
  "REFERENCE_IMAGE",
  "DEPTH_MAP",
  "NORMAL_MAP",
  "CANNY_MAP",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type UploadAssetType = (typeof UPLOAD_ASSET_TYPES)[number];
export type AssetStatus = "PENDING_UPLOAD" | "VERIFYING" | "READY" | "REJECTED" | "QUARANTINED";

export interface AssetSummary {
  id: string;
  project: { id: string; name: string; status: "ACTIVE" | "ARCHIVED" } | null;
  assetType: AssetType;
  status: AssetStatus;
  originalName: string | null;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  uploadExpired: boolean;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

export interface AssetListResult {
  items: AssetSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  policy: {
    maxUploadBytes: number;
    acceptedContentTypes: string[];
    uploadAssetTypes: UploadAssetType[];
  };
}

export class AssetClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "AssetClientError";
  }
}

type ApiEnvelope<T> = { ok: true } & T;

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    code?: string;
    retryable?: boolean;
  } & T;
  if (!response.ok || body.ok !== true) {
    throw new AssetClientError(body.code ?? "ASSET_REQUEST_FAILED", response.status, body.retryable);
  }
  return body;
}

export interface AssetListQuery {
  projectId?: string;
  assetType?: AssetType;
  status?: AssetStatus;
  search?: string;
  sort?: "newest" | "oldest" | "name" | "size";
  page?: number;
  pageSize?: number;
}

export async function listAssets(query: AssetListQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const body = await apiRequest<ApiEnvelope<{ result: AssetListResult }>>(
    `/api/assets?${params.toString()}`,
    { ...(signal ? { signal } : {}) },
  );
  return body.result;
}

export async function getAsset(assetId: string, signal?: AbortSignal) {
  const body = await apiRequest<ApiEnvelope<{ asset: AssetSummary }>>(
    `/api/assets/${encodeURIComponent(assetId)}`,
    { ...(signal ? { signal } : {}) },
  );
  return body.asset;
}

export async function getAssetReadUrl(assetId: string, signal?: AbortSignal) {
  const body = await apiRequest<ApiEnvelope<{
    result: { assetId: string; url: string; expiresAt: string };
  }>>(`/api/assets/${encodeURIComponent(assetId)}/read-url`, { ...(signal ? { signal } : {}) });
  return body.result;
}

export async function getAssetThumbnailUrl(
  assetId: string,
  variant: "grid" | "detail",
  signal?: AbortSignal,
) {
  const body = await apiRequest<ApiEnvelope<{
    result: { assetId: string; variant: "grid" | "detail"; url: string; expiresAt: string };
  }>>(`/api/assets/${encodeURIComponent(assetId)}/thumbnail?variant=${variant}`, {
    ...(signal ? { signal } : {}),
  });
  return body.result;
}

export async function deleteAsset(assetId: string) {
  const body = await apiRequest<ApiEnvelope<{
    result: { assetId: string; status: "DELETED" };
  }>>(`/api/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  return body.result;
}

export interface UploadContract {
  assetId: string;
  status: string;
  upload: {
    method: "PUT";
    url: string;
    expiresAt: string;
    requiredHeaders: Record<string, string>;
  };
}

export async function initiateAssetUpload(input: {
  requestId: string;
  projectId: string;
  assetType: UploadAssetType;
  originalName: string;
  contentType: string;
  byteSize: number;
}) {
  const body = await apiRequest<ApiEnvelope<{ result: UploadContract }>>("/api/assets/uploads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.result;
}

export async function completeAssetUpload(
  assetId: string,
  input: { etag?: string; checksumSha256?: string },
) {
  const body = await apiRequest<ApiEnvelope<{ asset: { assetId: string; status: string } }>>(
    `/api/assets/${encodeURIComponent(assetId)}/complete`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return body.asset;
}

export function assetErrorMessage(error: unknown): string {
  const code = error instanceof AssetClientError ? error.code : "ASSET_REQUEST_FAILED";
  const messages: Record<string, string> = {
    ASSET_INVALID_INPUT: "Tệp hoặc thông tin tải lên không hợp lệ.",
    ASSET_VALIDATION: "Thông tin gửi lên không hợp lệ.",
    ASSET_PROJECT_ARCHIVED: "Dự án đã lưu trữ và chỉ có thể xem.",
    ASSET_PROJECT_NOT_FOUND: "Không tìm thấy dự án hoặc bạn không có quyền truy cập.",
    ASSET_NOT_FOUND: "Không tìm thấy tài nguyên hoặc bạn không có quyền truy cập.",
    ASSET_REFERENCED: "Tài nguyên đang được một tác vụ sử dụng nên chưa thể xóa.",
    ASSET_UPLOAD_EXPIRED: "Phiên tải lên đã hết hạn. Hãy thử lại.",
    ASSET_VERIFICATION_FAILED: "Tệp không vượt qua bước xác minh an toàn.",
    ASSET_STORAGE_UNAVAILABLE: "Kho lưu trữ đang tạm thời gián đoạn. Hãy thử lại sau.",
    ASSET_INTEGRITY_CONFLICT: "Tệp đã thay đổi sau khi xác minh và bị khóa để bảo vệ dữ liệu.",
    ASSET_RATE_LIMITED: "Bạn thao tác quá nhanh. Hãy đợi một phút rồi thử lại.",
    ASSET_CONCURRENT_LIMIT: "Đang có quá nhiều lượt tải lên. Hãy đợi các lượt hiện tại hoàn tất.",
    ASSET_QUOTA_EXCEEDED: "Dung lượng lưu trữ đã đạt giới hạn.",
  };
  return messages[code] ?? "Không thể hoàn tất yêu cầu. Vui lòng thử lại.";
}
