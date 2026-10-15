import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = resolve(root, "config/models.manifest.json");
const modelRoot = resolve(root, "runtime/models");
const promotedManifestPath = resolve(root, "runtime/models.verified.manifest.json");
const mode = process.argv.includes("--promote") ? "promote" : "plan";
const requiredModelIds = new Set([
  "architecture_image_sdxl",
  "architecture_image_sdxl_control",
  "architecture_upscale_realesrgan_x4plus",
]);

const manifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
const requiredModels = manifest.models.filter((model) => requiredModelIds.has(model.id));
if (requiredModels.length !== requiredModelIds.size) fail("MODEL_SET_INCOMPLETE");

const uniqueArtifacts = new Map();
for (const model of requiredModels) {
  for (const artifact of model.artifacts) {
    if (!artifact.sha256 || !artifact.sizeBytes || !artifact.sourceRevision || !artifact.licenseUrl ||
        artifact.commercialUse === "UNKNOWN") fail("MODEL_EVIDENCE_INCOMPLETE");
    const existing = uniqueArtifacts.get(artifact.relativePath);
    if (existing && (existing.sha256 !== artifact.sha256 || existing.sizeBytes !== artifact.sizeBytes)) {
      fail("MODEL_IDENTITY_CONFLICT");
    }
    uniqueArtifacts.set(artifact.relativePath, artifact);
  }
}

const result = { mode, artifactCount: uniqueArtifacts.size, expectedBytes: 0, present: 0, verified: 0, missing: 0 };
const verification = new Map();
for (const [relativePath, artifact] of uniqueArtifacts) {
  result.expectedBytes += artifact.sizeBytes;
  const path = resolve(modelRoot, relativePath);
  if (!path.startsWith(`${modelRoot}\\`) && !path.startsWith(`${modelRoot}/`)) fail("MODEL_PATH_ESCAPE");
  let actual;
  try { actual = await stat(path); } catch (error) {
    if (error?.code === "ENOENT") { result.missing += 1; continue; }
    throw error;
  }
  result.present += 1;
  if (!actual.isFile() || actual.size !== artifact.sizeBytes) fail("MODEL_SIZE_MISMATCH");
  if (mode === "promote") {
    const checksum = await sha256File(path);
    if (checksum !== artifact.sha256) fail("MODEL_CHECKSUM_MISMATCH");
    verification.set(relativePath, true);
    result.verified += 1;
  }
}

if (mode === "promote") {
  if (result.missing !== 0 || result.verified !== uniqueArtifacts.size) fail("MODEL_SET_NOT_VERIFIED");
  const promoted = structuredClone(manifest);
  for (const model of promoted.models) {
    if (!requiredModelIds.has(model.id)) continue;
    model.status = "READY";
    for (const artifact of model.artifacts) {
      if (!verification.get(artifact.relativePath)) fail("MODEL_SET_NOT_VERIFIED");
      artifact.status = "VERIFIED";
    }
  }
  await durableWrite(promotedManifestPath, `${JSON.stringify(promoted, null, 2)}\n`);
}

console.log(JSON.stringify({ event: "MODEL_VERIFICATION", ...result }));

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

async function durableWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const tempHandle = await open(temporary, "wx");
  try { await tempHandle.writeFile(contents, "utf8"); await tempHandle.sync(); } finally { await tempHandle.close(); }
  await rename(temporary, path);
  const finalHandle = await open(path, "r+");
  try { await finalHandle.sync(); } finally { await finalHandle.close(); }
  const readBack = await readFile(path, "utf8");
  if (readBack !== contents) fail("MANIFEST_READBACK_MISMATCH");
}

function fail(code) {
  console.error(JSON.stringify({ event: "MODEL_VERIFICATION_FAILED", code }));
  process.exit(1);
}
