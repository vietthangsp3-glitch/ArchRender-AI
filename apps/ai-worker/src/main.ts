import "dotenv/config";

import { readFile } from "node:fs/promises";

import {
  AiWorkerRuntime,
  DisconnectedEngineAdapter,
  EngineGatewayClient,
  modelManifestSchema,
  PrivateGatewayEngineAdapter,
} from "@archrender/ai-engine";
import { createR2StorageProvider, GeneratedOutputService, loadAssetStorageConfig } from "@archrender/assets";
import { createDatabaseClient } from "@archrender/database";
import { WorkerQueueService } from "@archrender/jobs";
import { z } from "zod";

import { VerifiedInputMaterializer } from "./input-materializer";
import { BoundedGeneratedMediaInspector } from "./media-inspector";
import { ImmutableOutputCommitter } from "./output-committer";
import { DatabaseQueueAdapter } from "./queue-adapter";

const envSchema = z.object({
  AI_ENGINE_MODE: z.enum(["disconnected", "private"]).default("disconnected"),
  AI_ENGINE_GATEWAY_URL: z.string().url().optional(),
  AI_ENGINE_WORKER_TOKEN: z.string().min(32).optional(),
  AI_ENGINE_WORKER_ID: z.string().regex(/^[A-Za-z0-9_-]{3,160}$/).default("archrender_worker_v4"),
  AI_ENGINE_MODEL_MANIFEST_PATH: z.string().default("ai-engine/arch-ai-cloud-v4/config/models.manifest.json"),
  AI_ENGINE_AVAILABLE_NODES: z.string().default(""),
  AI_ENGINE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(1_800_000).default(600_000),
  AI_ENGINE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(10_000).default(2_000),
  AI_ENGINE_IDLE_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  AI_ENGINE_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1).max(512 * 1024 * 1024).default(100 * 1024 * 1024),
  AI_ENGINE_MAX_VRAM_MB: z.coerce.number().int().min(512).max(196_608).default(24_576),
}).passthrough();

async function main() {
  const environment = envSchema.parse(process.env);
  if (environment.AI_ENGINE_MODE === "disconnected") {
    safeLog({ event: "ai_worker_status", status: "DISCONNECTED" });
    return;
  }
  if (!environment.AI_ENGINE_GATEWAY_URL || !environment.AI_ENGINE_WORKER_TOKEN) {
    throw new Error("Private engine mode requires gateway URL and worker token.");
  }
  const manifest = modelManifestSchema.parse(JSON.parse(await readFile(environment.AI_ENGINE_MODEL_MANIFEST_PATH, "utf8")));
  const gateway = new EngineGatewayClient({ baseUrl: environment.AI_ENGINE_GATEWAY_URL, serviceToken: environment.AI_ENGINE_WORKER_TOKEN, timeoutMs: 30_000 });
  const engine = new PrivateGatewayEngineAdapter(gateway);
  if (await engine.health() !== "READY") throw new Error("AI engine gateway is not ready.");

  const database = createDatabaseClient();
  const storageConfig = loadAssetStorageConfig();
  const storage = createR2StorageProvider(storageConfig);
  const queueService = new WorkerQueueService(database);
  const runtime = new AiWorkerRuntime(
    new DatabaseQueueAdapter(queueService),
    engine,
    new VerifiedInputMaterializer(database, storage, gateway, storageConfig.maxUploadBytes),
    new ImmutableOutputCommitter(new GeneratedOutputService(database, storage, storageConfig, new BoundedGeneratedMediaInspector(storageConfig))),
    {
      workerId: environment.AI_ENGINE_WORKER_ID,
      manifest,
      availableNodeClasses: new Set(environment.AI_ENGINE_AVAILABLE_NODES.split(",").map((value) => value.trim()).filter(Boolean)),
      budget: {
        timeoutMs: environment.AI_ENGINE_TIMEOUT_MS,
        pollIntervalMs: environment.AI_ENGINE_POLL_INTERVAL_MS,
        maxOutputBytes: environment.AI_ENGINE_MAX_OUTPUT_BYTES,
        maxEstimatedVramMb: environment.AI_ENGINE_MAX_VRAM_MB,
        maxAttempts: 1,
      },
    },
  );
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    while (!stopping) {
      await queueService.recoverExpired(25);
      const outcome = await runtime.runOnce();
      safeLog({ event: "ai_worker_cycle", outcome });
      if (outcome === "IDLE") await new Promise((resolve) => setTimeout(resolve, environment.AI_ENGINE_IDLE_INTERVAL_MS));
    }
  } finally {
    await database.$disconnect();
    safeLog({ event: "ai_worker_status", status: "STOPPED" });
  }
}

function safeLog(value: Record<string, string>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().catch(() => {
  safeLog({ event: "ai_worker_status", status: "FAILED_SAFE" });
  process.exitCode = 1;
});
