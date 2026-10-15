import { randomBytes } from "node:crypto";
import { z } from "zod";

import type { StorageEnvironment, StorageObjectKey } from "./types";

const idSchema = z.string().uuid();

export interface ObjectKeyInput {
  environment: StorageEnvironment;
  ownerId: string;
  projectId: string;
  assetId: string;
  randomId?: string;
}

export type AssetObjectRole = "legacy" | "staging" | "original" | "derivatives/grid" | "derivatives/detail";

function createKey(input: ObjectKeyInput, role?: AssetObjectRole): StorageObjectKey {
  const ownerId = idSchema.parse(input.ownerId);
  const projectId = idSchema.parse(input.projectId);
  const assetId = idSchema.parse(input.assetId);
  const randomId = input.randomId ?? randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{32}$/i.test(randomId)) throw new Error("Invalid storage random identifier.");
  const prefix = `${input.environment}/owners/${ownerId}/projects/${projectId}/assets/${assetId}`;
  return `${prefix}/${role && role !== "legacy" ? `${role}/` : ""}${randomId}` as StorageObjectKey;
}

export function createAssetObjectKey(input: ObjectKeyInput): StorageObjectKey {
  return createKey(input, "legacy");
}

export function createStagingObjectKey(input: ObjectKeyInput): StorageObjectKey {
  return createKey(input, "staging");
}

export function createFinalObjectKey(input: ObjectKeyInput): StorageObjectKey {
  return createKey(input, "original");
}

export function createThumbnailObjectKey(
  input: ObjectKeyInput,
  variant: "grid" | "detail",
): StorageObjectKey {
  return createKey(input, variant === "grid" ? "derivatives/grid" : "derivatives/detail");
}
