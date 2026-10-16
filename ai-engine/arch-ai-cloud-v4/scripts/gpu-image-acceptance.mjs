import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRemoteManifest } from "./runpod-manifest-contract.mjs";

process.on("uncaughtException", () => {
  console.error(JSON.stringify({ event: "GPU_IMAGE_ACCEPTANCE_FAILED", code: "UNEXPECTED_ERROR" }));
  process.exit(1);
});
process.on("unhandledRejection", () => {
  console.error(JSON.stringify({ event: "GPU_IMAGE_ACCEPTANCE_FAILED", code: "UNEXPECTED_ERROR" }));
  process.exit(1);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");
const target = process.env.GPU_ACCEPTANCE_TARGET ?? "compose";
if (!new Set(["compose", "runpod"]).has(target)) fail("GPU_ACCEPTANCE_TARGET_INVALID");
const maxRuntimeMinutes = integerEnv("GPU_ACCEPTANCE_MAX_RUNTIME_MINUTES", 45, 10, 45);
const hardCostCapUsd = numberEnv("GPU_ACCEPTANCE_HARD_COST_CAP_USD", 1.0, 0.01, 1.0);
const quotedHourlyUsd = numberEnv("GPU_ACCEPTANCE_QUOTED_HOURLY_USD", 0, 0, 10);
const fixedCostUsd = numberEnv("GPU_ACCEPTANCE_FIXED_COST_USD", 0, 0, 1);
const estimatedCostUsd = quotedHourlyUsd * maxRuntimeMinutes / 60 + fixedCostUsd;
const fixtureDirectory = resolve(root, "fixtures");
const runtimeDirectory = resolve(root, "runtime/acceptance");
const recoveryPath = resolve(runtimeDirectory, "recovery.json");
const composeManifestPath = resolve(root, "runtime/models.verified.manifest.json");
const runpodManifestPath = resolve(root, "runtime/models.verified.runpod.json");
const composeFile = resolve(root, "docker-compose.yml");
const fixtureCriteria = JSON.parse(await readFile(resolve(fixtureDirectory, "golden-courtyard.criteria.json"), "utf8"));
const fixtureBytes = new Map();

for (const input of fixtureCriteria.inputs) {
  const bytes = new Uint8Array(await readFile(resolve(fixtureDirectory, input.file)));
  if (bytes.byteLength !== input.sizeBytes || sha256(bytes) !== input.sha256) fail("FIXTURE_IDENTITY_MISMATCH");
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== fixtureCriteria.width || dimensions.height !== fixtureCriteria.height) fail("FIXTURE_DIMENSIONS_MISMATCH");
  fixtureBytes.set(input.role, { ...input, bytes });
}

const plan = {
  event: "GPU_IMAGE_ACCEPTANCE_PLAN",
  mode: execute ? "EXECUTE" : "PLAN",
  target: target.toUpperCase(),
  providerProvisioning: false,
  maxRuntimeMinutes,
  hardCostCapUsd,
  estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
  jobs: ["SDXL_IMG2IMG", "CONTROLNET_CANNY", "CONTROLNET_DEPTH", "REALESRGAN_X4"],
  stagedInputs: 4,
  expectedRenderOutputs: 4,
  videoIncluded: false,
  customNodes: 0,
};
console.log(JSON.stringify(plan));
if (!execute) process.exit(0);

if (process.env.ARCHRENDER_ENVIRONMENT !== "development") fail("ENVIRONMENT_NOT_DEVELOPMENT");
if (process.env.GPU_ACCEPTANCE_APPROVAL !== "PHASE3_IMAGE_ACCEPTANCE_APPROVED") fail("OPERATOR_APPROVAL_MISSING");
if (quotedHourlyUsd <= 0 || estimatedCostUsd > hardCostCapUsd) fail("COST_CAP_INVALID");
if ((process.env.AI_ENGINE_WORKER_TOKEN ?? "").length < 32) fail("WORKER_TOKEN_INVALID");
if (await exists(recoveryPath)) fail("RECOVERY_OBLIGATION_EXISTS");
if (target === "runpod") {
  const gatewayUrl = new URL(process.env.AI_ENGINE_GATEWAY_URL ?? "http://invalid");
  if (gatewayUrl.protocol !== "https:" || gatewayUrl.username || gatewayUrl.password || gatewayUrl.pathname !== "/" || gatewayUrl.search || gatewayUrl.hash) {
    fail("RUNPOD_GATEWAY_HTTPS_REQUIRED");
  }
}

let manifestPath = composeManifestPath;
let models;
if (target === "compose") {
  execFileSync(process.execPath, [resolve(root, "scripts/verify-models.mjs"), "--promote"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000,
  });
  models = JSON.parse(await readFile(manifestPath, "utf8"));
} else {
  models = await fetchVerifiedRunpodManifest();
  manifestPath = runpodManifestPath;
  await persistJsonFile(manifestPath, models);
}
const baseModel = readyModel(models, "architecture_image_sdxl");
const controlModel = readyModel(models, "architecture_image_sdxl_control");
const upscaleModel = readyModel(models, "architecture_upscale_realesrgan_x4plus");

const runId = randomBytes(8).toString("hex");
const project = `archrender-gpu-acceptance-${runId}`;
const runDirectory = resolve(runtimeDirectory, runId);
const deadline = Date.now() + maxRuntimeMinutes * 60_000;
const state = {
  schemaVersion: 1, runId, state: "PREPARED", createdAt: new Date().toISOString(),
  target,
  obligations: target === "compose" ? [{ kind: "COMPOSE_PROJECT", identity: project }] : [],
};
await mkdir(runDirectory, { recursive: true });
await persistRecovery(state);

let composeStarted = false;
let passed = false;
try {
  if (target === "compose") {
    compose(["config", "--quiet"], 30_000);
    composeStarted = true;
    compose(["up", "--build", "--detach", "--wait"], Math.min(20 * 60_000, remaining()));
  }
  state.state = "RUNNING";
  await persistRecovery(state);
  await requireAuthDenial();

  const workspace = createHash("sha256").update(`gpu:${runId}`).digest("hex");
  const staged = {};
  for (const role of ["source", "canny", "depth"]) staged[role] = await stage(workspace, fixtureBytes.get(role));

  const baseOutput = await executeJob("SDXL_IMG2IMG", compileImage(baseModel, staged.source, null), 1024, 1024);
  await stageBytes(workspace, "base-output.png", baseOutput.bytes, baseOutput.sha256);
  const cannyOutput = await executeJob("CONTROLNET_CANNY", compileImage(controlModel, staged.source, { role: "CANNY", file: staged.canny }), 1024, 1024);
  const depthOutput = await executeJob("CONTROLNET_DEPTH", compileImage(controlModel, staged.source, { role: "DEPTH", file: staged.depth }), 1024, 1024);
  const upscaleOutput = await executeJob("REALESRGAN_X4", compileUpscale(upscaleModel, `${workspace}_base-output.png`), 4096, 4096);

  if ([baseOutput, cannyOutput, depthOutput].some((output) => output.sha256 === fixtureBytes.get("source").sha256)) {
    fail("OUTPUT_IDENTICAL_TO_SOURCE");
  }
  const evidence = {
    schemaVersion: 1, runId, completedAt: new Date().toISOString(),
    outcomes: [baseOutput, cannyOutput, depthOutput, upscaleOutput].map(({ bytes, ...safe }) => safe),
    manualRubric: fixtureCriteria.manualRubric,
    cost: { quotedHourlyUsd, fixedCostUsd, hardCostCapUsd, maxRuntimeMinutes },
  };
  await writeFile(resolve(runDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  passed = true;
} finally {
  state.state = "CLEANING";
  await persistRecovery(state);
  await cleanupStagedInputs();
  if (composeStarted) {
    try {
      compose(["down", "--volumes", "--remove-orphans", "--timeout", "30"], Math.min(120_000, Math.max(10_000, remaining())));
      state.obligations = [];
    } catch { /* preserve recovery identity */ }
  }
  if (state.obligations.length === 0) {
    state.state = passed ? "COMPLETE" : "FAILED_CLEAN";
    await persistRecovery(state);
    await rm(recoveryPath);
  } else {
    state.state = "RECOVERY_REQUIRED";
    await persistRecovery(state);
  }
}

if (!passed) fail("ACCEPTANCE_FAILED");
console.log(JSON.stringify({ event: "GPU_IMAGE_ACCEPTANCE", status: "PASS", runId, recoveryObligations: 0 }));

function compose(args, timeout) {
  ensureTime();
  execFileSync("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout,
    env: { ...process.env, AI_ENGINE_MODEL_MANIFEST_PATH: manifestPath },
  });
}

async function requireAuthDenial() {
  const response = await request(`/v1/executions/${randomUUID()}`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } });
  if (response.status !== 401) fail("GATEWAY_AUTH_DENIAL_FAILED");
}

async function stage(workspace, fixture) {
  await stageBytes(workspace, fixture.file, fixture.bytes, fixture.sha256);
  return `${workspace}_${fixture.file}`;
}

async function stageBytes(workspace, filename, bytes, checksum) {
  const obligation = { kind: "STAGED_INPUT", workspace, filename, checksum };
  state.obligations.push(obligation);
  await persistRecovery(state);
  const response = await request(`/v1/workspaces/${workspace}/inputs/${encodeURIComponent(filename)}`, {
    method: "PUT", headers: authHeaders({ "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), "x-content-sha256": checksum }), body: bytes,
  });
  if (![200, 201].includes(response.status)) fail("INPUT_STAGE_FAILED");
}

async function cleanupStagedInputs() {
  const pending = state.obligations.filter((item) => item.kind === "STAGED_INPUT").reverse();
  for (const item of pending) {
    try {
      const response = await cleanupRequest(`/v1/workspaces/${item.workspace}/inputs/${encodeURIComponent(item.filename)}`, {
        method: "DELETE", headers: authHeaders({ "x-content-sha256": item.checksum }),
      });
      if (![200, 404].includes(response.status)) continue;
      state.obligations = state.obligations.filter((candidate) => candidate !== item);
      await persistRecovery(state);
    } catch { /* preserve exact recovery identity */ }
  }
}

async function executeJob(label, prompt, width, height) {
  const requestId = randomUUID();
  const outputPrefix = `${label.toLowerCase().replaceAll("_", "-")}-${runId}`;
  for (const current of Object.values(prompt)) {
    if (current.class_type === "SaveImage") current.inputs.filename_prefix = outputPrefix;
  }
  const obligation = { kind: "EXECUTION_OUTPUT", requestId, outputPrefix };
  state.obligations.push(obligation);
  await persistRecovery(state);
  const submit = await requestJson("/v1/executions", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ requestId, jobId: randomUUID(), generation: 1, prompt }) });
  if (!/^[0-9a-f-]{36}$/.test(submit.executionId ?? "")) fail("EXECUTION_ID_INVALID");
  let result;
  for (let polls = 0; polls < 180; polls += 1) {
    ensureTime();
    result = await requestJson(`/v1/executions/${submit.executionId}`, { headers: authHeaders() });
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(result.state)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  if (result?.state !== "SUCCEEDED" || result.outputs?.length !== 1) fail("EXECUTION_NOT_SUCCEEDED");
  const declared = result.outputs[0];
  const outputResponse = await request(`/v1/executions/${submit.executionId}/outputs/${encodeURIComponent(declared.filename)}`, { headers: authHeaders() });
  if (outputResponse.status !== 200 || outputResponse.headers.get("content-type") !== "image/png") fail("OUTPUT_READ_FAILED");
  const bytes = new Uint8Array(await outputResponse.arrayBuffer());
  if (bytes.byteLength !== declared.byteSize || bytes.byteLength < 12 || bytes.byteLength > 128 * 1024 * 1024) fail("OUTPUT_SIZE_INVALID");
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== width || dimensions.height !== height) fail("OUTPUT_DIMENSIONS_INVALID");
  const checksum = sha256(bytes);
  await writeFile(resolve(runDirectory, `${label.toLowerCase()}.png`), bytes, { flag: "wx" });
  return { scenario: label, status: "PASS", width, height, byteSize: bytes.byteLength, sha256: checksum, bytes };
}

function compileImage(model, source, control) {
  const checkpoint = model.artifacts.find((item) => item.relativePath.startsWith("checkpoints/")).relativePath.replace("checkpoints/", "");
  const prompt = {
    "1": node("LoadImage", { image: source }), "2": node("CheckpointLoaderSimple", { ckpt_name: checkpoint }),
    "3": node("CLIPTextEncode", { text: "modern architectural courtyard, faithful geometry, natural materials, daylight", clip: ["2", 1] }),
    "4": node("CLIPTextEncode", { text: "distorted structure, duplicate windows, impossible geometry, text, people", clip: ["2", 1] }),
    "5": node("VAEEncode", { pixels: ["1", 0], vae: ["2", 2] }),
  };
  let positive = ["3", 0]; let negative = ["4", 0];
  if (control) {
    const artifact = model.artifacts.find((item) => item.relativePath.includes(control.role.toLowerCase()));
    if (!artifact) fail("CONTROL_MODEL_MISSING");
    prompt["20"] = node("LoadImage", { image: control.file });
    prompt["21"] = node("ControlNetLoader", { control_net_name: artifact.relativePath.replace("controlnet/", "") });
    prompt["22"] = node("ControlNetApplyAdvanced", { positive, negative, control_net: ["21", 0], image: ["20", 0], strength: 0.8, start_percent: 0, end_percent: 0.85 });
    positive = ["22", 0]; negative = ["22", 1];
  }
  prompt["6"] = node("KSampler", { model: ["2", 0], positive, negative, latent_image: ["5", 0], seed: 19031986, steps: 24, cfg: 6.5, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 0.38 });
  prompt["7"] = node("VAEDecode", { samples: ["6", 0], vae: ["2", 2] });
  prompt["8"] = node("SaveImage", { images: ["7", 0], filename_prefix: "acceptance-output" });
  return prompt;
}

function compileUpscale(model, source) {
  const artifact = model.artifacts.find((item) => item.relativePath.startsWith("upscale_models/"));
  return { "1": node("LoadImage", { image: source }), "2": node("UpscaleModelLoader", { model_name: artifact.relativePath.replace("upscale_models/", "") }), "3": node("ImageUpscaleWithModel", { upscale_model: ["2", 0], image: ["1", 0] }), "4": node("SaveImage", { images: ["3", 0], filename_prefix: "acceptance-output" }) };
}

function node(class_type, inputs) { return { class_type, inputs, _meta: { title: "Bounded acceptance" } }; }
function readyModel(manifest, id) { const model = manifest.models.find((item) => item.id === id); if (!model || model.status !== "READY" || model.artifacts.some((item) => item.status !== "VERIFIED")) fail("MODEL_NOT_READY"); return model; }
async function fetchVerifiedRunpodManifest() {
  const response = await fetch(new URL("/v1/model-manifest", process.env.AI_ENGINE_GATEWAY_URL), {
    headers: authHeaders(), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 || response.headers.get("content-type") !== "application/json") fail("RUNPOD_MODEL_MANIFEST_UNAVAILABLE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) fail("RUNPOD_MODEL_MANIFEST_INVALID");
  let remote;
  try { remote = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { fail("RUNPOD_MODEL_MANIFEST_INVALID"); }
  const source = JSON.parse(await readFile(resolve(root, "config/models.manifest.json"), "utf8"));
  try {
    validateRemoteManifest(source, remote);
  } catch (error) {
    fail(error?.code ?? "RUNPOD_MODEL_MANIFEST_INVALID");
  }
  return remote;
}
function authHeaders(extra = {}) { return { authorization: `Bearer ${process.env.AI_ENGINE_WORKER_TOKEN}`, accept: "application/json", ...extra }; }
async function request(path, init = {}) { ensureTime(); return fetch(new URL(path, process.env.AI_ENGINE_GATEWAY_URL ?? "http://127.0.0.1:8189"), { ...init, redirect: "error", signal: AbortSignal.timeout(Math.min(30_000, remaining())) }); }
async function cleanupRequest(path, init = {}) { return fetch(new URL(path, process.env.AI_ENGINE_GATEWAY_URL ?? "http://127.0.0.1:8189"), { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
async function requestJson(path, init) { const response = await request(path, init); if (!response.ok) fail("GATEWAY_REQUEST_REJECTED"); return response.json(); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pngDimensions(bytes) { if (bytes.byteLength < 24 || Buffer.from(bytes.subarray(1, 4)).toString("ascii") !== "PNG") fail("PNG_INVALID"); return { width: Buffer.from(bytes).readUInt32BE(16), height: Buffer.from(bytes).readUInt32BE(20) }; }
function ensureTime() { if (Date.now() >= deadline) fail("HARD_TIMEOUT"); }
function remaining() { return Math.max(1, deadline - Date.now()); }
function integerEnv(name, fallback, min, max) { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value) || value < min || value > max) fail(`${name}_INVALID`); return value; }
function numberEnv(name, fallback, min, max) { const value = Number(process.env[name] ?? fallback); if (!Number.isFinite(value) || value < min || value > max) fail(`${name}_INVALID`); return value; }
async function exists(path) { try { await readFile(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function persistRecovery(value) { await mkdir(runtimeDirectory, { recursive: true }); const body = `${JSON.stringify(value, null, 2)}\n`; const temporary = `${recoveryPath}.${process.pid}.tmp`; const handle = await open(temporary, "wx"); try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); } await rename(temporary, recoveryPath); const finalHandle = await open(recoveryPath, "r+"); try { await finalHandle.sync(); } finally { await finalHandle.close(); } if (await readFile(recoveryPath, "utf8") !== body) fail("RECOVERY_MANIFEST_READBACK_FAILED"); }
async function persistJsonFile(path, value) { await mkdir(dirname(path), { recursive: true }); const body = `${JSON.stringify(value, null, 2)}\n`; const temporary = `${path}.${process.pid}.tmp`; const handle = await open(temporary, "wx"); try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); } await rename(temporary, path); const finalHandle = await open(path, "r+"); try { await finalHandle.sync(); } finally { await finalHandle.close(); } if (await readFile(path, "utf8") !== body) fail("RUNPOD_MANIFEST_READBACK_FAILED"); }
function fail(code) { console.error(JSON.stringify({ event: "GPU_IMAGE_ACCEPTANCE_FAILED", code })); process.exitCode = 1; throw new Error(code); }
