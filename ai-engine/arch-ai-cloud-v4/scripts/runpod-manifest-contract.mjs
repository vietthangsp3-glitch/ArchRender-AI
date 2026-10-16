export class RunpodManifestContractError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const REQUIRED_READY = new Set([
  "architecture_image_sdxl",
  "architecture_image_sdxl_control",
  "architecture_upscale_realesrgan_x4plus",
]);
const IDENTITY_FIELDS = [
  "name", "relativePath", "sha256", "sourceUrl", "sourceRevision",
  "sizeBytes", "license", "licenseUrl", "commercialUse",
];

function reject(code) {
  throw new RunpodManifestContractError(code);
}

export function validateRemoteManifest(source, remote) {
  if (remote?.schemaVersion !== 2 || !Array.isArray(remote.models) || remote.models.length !== source.models.length) {
    reject("RUNPOD_MODEL_MANIFEST_INVALID");
  }
  for (const sourceModel of source.models) {
    const remoteModel = remote.models.find((item) => item?.id === sourceModel.id);
    if (!remoteModel || remoteModel.revision !== sourceModel.revision || !Array.isArray(remoteModel.artifacts) || remoteModel.artifacts.length !== sourceModel.artifacts.length) {
      reject("RUNPOD_MODEL_IDENTITY_MISMATCH");
    }
    if (REQUIRED_READY.has(sourceModel.id)) {
      if (remoteModel.status !== "READY" || remoteModel.artifacts.some((item) => item?.status !== "VERIFIED")) {
        reject("RUNPOD_MODEL_NOT_READY");
      }
    } else if (remoteModel.status !== "DISABLED") {
      reject("RUNPOD_MODEL_SCOPE_INVALID");
    }
    for (const sourceArtifact of sourceModel.artifacts) {
      const remoteArtifact = remoteModel.artifacts.find((item) => item?.relativePath === sourceArtifact.relativePath);
      if (!remoteArtifact || IDENTITY_FIELDS.some((field) => remoteArtifact[field] !== sourceArtifact[field])) {
        reject("RUNPOD_MODEL_IDENTITY_MISMATCH");
      }
    }
  }
}
