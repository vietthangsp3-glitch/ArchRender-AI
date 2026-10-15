import "server-only";

import {
  AssetService,
  ThumbnailService,
  createR2StorageProvider,
  loadAssetStorageConfig,
} from "@archrender/assets";
import { getDatabaseClient } from "@archrender/database";

let assetService: AssetService | undefined;
let thumbnailService: ThumbnailService | undefined;

export function getAssetService(): AssetService {
  if (!assetService) {
    const config = loadAssetStorageConfig();
    assetService = new AssetService(
      getDatabaseClient(),
      createR2StorageProvider(config),
      config,
    );
  }
  return assetService;
}

export function getThumbnailService(): ThumbnailService {
  if (!thumbnailService) {
    const config = loadAssetStorageConfig();
    thumbnailService = new ThumbnailService(
      getDatabaseClient(),
      createR2StorageProvider(config),
      config,
    );
  }
  return thumbnailService;
}
