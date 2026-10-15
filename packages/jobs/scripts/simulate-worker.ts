import { config as loadEnvironment } from "dotenv";

import { createDatabaseClient } from "@archrender/database";

import { WorkerQueueService } from "../src/worker-queue-service.js";

loadEnvironment({ path: new URL("../../database/.env", import.meta.url), quiet: true });
loadEnvironment({ path: new URL("../../../apps/web/.env.local", import.meta.url), quiet: true });

const execute = process.argv.includes("--execute");
const environment = process.argv.find((value) => value.startsWith("--environment="))?.split("=", 2)[1];
const scenario = process.argv.find((value) => value.startsWith("--scenario="))?.split("=", 2)[1] ?? "success";
if (!execute || environment !== "development" || process.env["NODE_ENV"] === "production") {
  throw new Error("SIMULATION_EXPLICIT_DEVELOPMENT_OPT_IN_REQUIRED");
}
if (!/^(success|failure|crash)$/.test(scenario)) throw new Error("SIMULATION_SCENARIO_INVALID");

const database = createDatabaseClient();
try {
  const queue = new WorkerQueueService(database);
  const claim = await queue.claim(`simulation-${process.pid}`, 60);
  if (!claim) {
    process.stdout.write("SIMULATION=IDLE\n");
  } else {
    await queue.start(claim);
    await queue.heartbeat(claim, 25, 60);
    if (scenario === "success") {
      await queue.heartbeat(claim, 75, 60);
      await queue.succeed(claim);
      process.stdout.write("SIMULATION=SUCCEEDED\n");
    } else if (scenario === "failure") {
      await queue.fail(claim, "SIMULATED_FAILURE", false);
      process.stdout.write("SIMULATION=FAILED_AS_REQUESTED\n");
    } else {
      process.stdout.write("SIMULATION=CRASH_LEASE_LEFT_FOR_RECOVERY\n");
    }
  }
} finally {
  await database.$disconnect();
}
