import { config as loadEnvironment } from "dotenv";

import { createDatabaseClient } from "@archrender/database";

import { AssetMaintenanceService } from "../src/asset-maintenance-service.js";
import { loadAssetStorageConfig } from "../src/config.js";
import { createR2StorageProvider } from "../src/r2-storage-provider.js";

loadEnvironment({ path: new URL("../../database/.env", import.meta.url), quiet: true });
loadEnvironment({ path: new URL("../../../apps/web/.env.local", import.meta.url), quiet: true });

const config = loadAssetStorageConfig();
const database = createDatabaseClient();
const execute = process.argv.includes("--execute");
const environmentArgument = process.argv.find((argument) => argument.startsWith("--environment="))?.split("=", 2)[1];
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="))?.split("=", 2)[1];
const limit = limitArgument ? Number(limitArgument) : 100;
if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_BATCH_LIMIT");
if (execute && environmentArgument !== config.environment) throw new Error("ENVIRONMENT_CONFIRMATION_REQUIRED");

try {
  const result = await new AssetMaintenanceService(
    database,
    createR2StorageProvider(config),
    config,
  ).run({
    limit,
    dryRun: !execute,
    ...(execute ? { confirmedEnvironment: config.environment } : {}),
  });
  console.log(
    `[assets.cleanup] mode=${execute ? "execute" : "dry-run"} environment=${config.environment} ` +
    `scanned=${result.scanned} plannedDeletes=${result.plannedDeletes} ` +
    `plannedRecoveries=${result.plannedRecoveries} deleted=${result.deleted} ` +
    `recovered=${result.recovered} skippedReferenced=${result.skippedReferenced} failed=${result.failed}`,
  );
} finally {
  await database.$disconnect();
}
