import { config as loadEnvironment } from "dotenv";

loadEnvironment({ path: new URL("../../../database/.env", import.meta.url), quiet: true });
