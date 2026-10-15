import { config as loadEnvironment } from "dotenv";

loadEnvironment({ path: new URL("../../../database/.env", import.meta.url), quiet: true });
loadEnvironment({ path: new URL("../../../../apps/web/.env.local", import.meta.url), quiet: true });
