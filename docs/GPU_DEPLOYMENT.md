# GPU deployment — RunPod RTX 4090

This guide prepares one development image-acceptance run. It does not authorize provisioning, model downloads or production deployment.

## Recommended bounded configuration

- RunPod Secure Cloud, one RTX 4090 24 GB; verify the live checkout quote before rental.
- At least 40 GB host RAM, 80 GB container disk, 8 GB shared memory and an NVIDIA driver compatible with CUDA 12.4 (550.54.14 or newer preferred).
- Maximum runtime 45 minutes and total hard cap USD 1.00. Abort before creation if the quote cannot satisfy both limits.
- No public ComfyUI port. The gateway binds to `127.0.0.1:8189`; ComfyUI stays on the internal Compose network.

## Required environment variable names

Gateway/acceptance:

```text
AI_ENGINE_WORKER_TOKEN
AI_ENGINE_BIND_ADDRESS
AI_ENGINE_GATEWAY_PORT
AI_ENGINE_MAX_REQUEST_BYTES
AI_ENGINE_MAX_INPUT_BYTES
AI_ENGINE_UPSTREAM_TIMEOUT_SECONDS
ARCHRENDER_ENVIRONMENT
GPU_ACCEPTANCE_APPROVAL
GPU_ACCEPTANCE_MAX_RUNTIME_MINUTES
GPU_ACCEPTANCE_HARD_COST_CAP_USD
GPU_ACCEPTANCE_QUOTED_HOURLY_USD
GPU_ACCEPTANCE_FIXED_COST_USD
```

Database worker (server-side only):

```text
DATABASE_URL
AI_ENGINE_MODE
AI_ENGINE_GATEWAY_URL
AI_ENGINE_WORKER_TOKEN
AI_ENGINE_WORKER_ID
AI_ENGINE_MODEL_MANIFEST_PATH
AI_ENGINE_AVAILABLE_NODES
AI_ENGINE_TIMEOUT_MS
AI_ENGINE_POLL_INTERVAL_MS
AI_ENGINE_IDLE_INTERVAL_MS
AI_ENGINE_MAX_OUTPUT_BYTES
AI_ENGINE_MAX_VRAM_MB
R2_ACCOUNT_ID
R2_BUCKET_NAME
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_ENDPOINT
ASSET_STORAGE_ENVIRONMENT
```

Never place values in Git, Docker build arguments, screenshots or support logs. Prefer RunPod secrets or an operator-owned mode-0600 environment file.

## Model installation

1. Review `ai-engine/arch-ai-cloud-v4/config/models.manifest.json` and the upstream licenses.
2. Download only the three enabled image model groups from the pinned official revisions into `ai-engine/arch-ai-cloud-v4/runtime/models` at the exact relative paths.
3. Do not enable Wan 2.2.
4. Run `node ai-engine/arch-ai-cloud-v4/scripts/verify-models.mjs`; verify the expected byte count and missing list.
5. Run the same command with `--promote` only after every size and SHA-256 matches. The ignored `runtime/models.verified.manifest.json` is the only accepted READY manifest.

## Boot and health checks

```bash
nvidia-smi
docker version
docker compose -f ai-engine/arch-ai-cloud-v4/docker-compose.yml config --quiet
docker compose -f ai-engine/arch-ai-cloud-v4/docker-compose.yml up --build --detach --wait
curl --fail http://127.0.0.1:8189/healthz
```

Inside the ComfyUI container, `verify-runtime.py` must confirm the pinned commit, PyTorch 2.6.0, CUDA availability and the expected CUDA/cuDNN runtime before startup. A process-only health response is insufficient if models are not verified.

## Acceptance procedure

1. Capture the actual hourly quote and set the cost variables without printing secrets.
2. Confirm there is no `runtime/acceptance/recovery.json` obligation.
3. Run the PLAN command without `--execute` and review four image jobs: SDXL img2img, Canny, Depth and RealESRGAN x4.
4. After explicit paid-operation approval, run exactly one `gpu-image-acceptance.mjs --execute` attempt.
5. Stop on any model, integrity, timeout or cost-cap error. Do not rerun automatically.
6. Preserve `recovery.json` if cleanup is incomplete; reconcile only its exact Compose project and staged inputs.

## ENOMEM / OOM response

- Stop accepting new jobs and retain the current lease/recovery identities.
- Capture only redacted GPU/RAM metrics; never dump prompts, signed URLs or environment values.
- Cancel the exact execution, allow queue lease recovery, and reduce resolution/control count before a new approved run.
- Do not silently switch model, disable verification or increase retry count. If SDXL plus controls cannot remain below 24 GB, use a larger approved GPU rather than an unsafe workaround.

## Safe shutdown

```bash
docker compose -f ai-engine/arch-ai-cloud-v4/docker-compose.yml down --volumes --remove-orphans --timeout 30
nvidia-smi
```

Verify zero recovery obligations and copy only redacted acceptance evidence before deleting the Pod. RunPod deletion and billing confirmation remain manual operator actions.
