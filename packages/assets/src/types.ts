export const UPLOAD_ASSET_TYPES = [
  "SOURCE_IMAGE",
  "REFERENCE_IMAGE",
  "DEPTH_MAP",
  "NORMAL_MAP",
  "CANNY_MAP",
] as const;

export type UploadAssetType = (typeof UPLOAD_ASSET_TYPES)[number];

export const SUPPORTED_IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;
export type SupportedImageFormat = (typeof SUPPORTED_IMAGE_FORMATS)[number];

export type AssetLifecycleStatus =
  | "PENDING_UPLOAD"
  | "VERIFYING"
  | "READY"
  | "REJECTED"
  | "DELETED";

export type StorageEnvironment = "development" | "staging" | "production";

declare const storageObjectKeyBrand: unique symbol;
export type StorageObjectKey = string & { readonly [storageObjectKeyBrand]: true };

export interface InspectedImage {
  format: SupportedImageFormat;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  byteSize: number;
}

export interface AssetProjectSummary {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
}

export interface AssetSummary {
  id: string;
  project: AssetProjectSummary | null;
  assetType: string;
  status: string;
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
    acceptedContentTypes: readonly string[];
    uploadAssetTypes: readonly UploadAssetType[];
  };
}
