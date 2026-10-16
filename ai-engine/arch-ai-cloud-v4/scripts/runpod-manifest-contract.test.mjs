import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

import { validateRemoteManifest } from "./runpod-manifest-contract.mjs";

const source = JSON.parse(await readFile(resolve(import.meta.dirname, "../config/models.manifest.json"), "utf8"));

function promoted() {
  const remote = structuredClone(source);
  for (const model of remote.models) {
    if (model.id === "architecture_video_wan22") continue;
    model.status = "READY";
    for (const artifact of model.artifacts) artifact.status = "VERIFIED";
  }
  return remote;
}

test("accepts only the exact promoted image model set", () => {
  assert.doesNotThrow(() => validateRemoteManifest(source, promoted()));
});

test("rejects a changed artifact identity", () => {
  const remote = promoted();
  remote.models[0].artifacts[0].sha256 = "0".repeat(64);
  assert.throws(() => validateRemoteManifest(source, remote), { message: "RUNPOD_MODEL_IDENTITY_MISMATCH" });
});

test("keeps the video model disabled", () => {
  const remote = promoted();
  remote.models.find((model) => model.id === "architecture_video_wan22").status = "READY";
  assert.throws(() => validateRemoteManifest(source, remote), { message: "RUNPOD_MODEL_SCOPE_INVALID" });
});
