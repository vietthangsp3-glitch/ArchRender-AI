import { z } from "zod";

import { IMAGE_MIME_TYPES } from "./policy";
import { UPLOAD_ASSET_TYPES } from "./types";

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

export const ASSET_STATUSES = [
  "PENDING_UPLOAD",
  "VERIFYING",
  "READY",
  "REJECTED",
  "QUARANTINED",
] as const;

export const prepareAssetUploadSchema = z.object({
  requestId: z.string().uuid(),
  projectId: z.string().uuid(),
  assetType: z.enum(UPLOAD_ASSET_TYPES),
  originalName: z.string().min(1).max(512),
  contentType: z.enum(IMAGE_MIME_TYPES),
  byteSize: z.number().int().positive(),
}).strict();

export const assetIdSchema = z.string().uuid();

export const completeAssetUploadSchema = z.object({
  etag: z.string().trim().min(1).max(256).optional(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();

export const listAssetsSchema = z.object({
  projectId: z.uuid().optional(),
  assetType: z.enum(ASSET_TYPES).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  search: z.string().trim().max(100).optional().default(""),
  sort: z.enum(["newest", "oldest", "name", "size"]).optional().default("newest"),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(24).optional().default(20),
}).strict();

export type PrepareAssetUploadInput = z.infer<typeof prepareAssetUploadSchema>;
export type CompleteAssetUploadInput = z.infer<typeof completeAssetUploadSchema>;
export type ListAssetsInput = z.input<typeof listAssetsSchema>;
