# GPU deployment — RunPod RTX 4090

This guide prepares one development image-acceptance run. It does not authorize provisioning, model downloads or production deployment.

## Recommended bounded configuration

- RunPod Secure Cloud, one RTX 4090 24 GB; verify the live checkout quote before rental.
- At least 40 GB host RAM, 80 GB container disk, 8 GB shared memory and an NVIDIA driver compatible with CUDA 12.4 (550.54.14 or newer preferred).
- Maximum runtime 45 minutes and total hard cap USD 1.00. Abort before creation if the quote cannot satisfy both limits.
- No public ComfyUI port. The gateway binds to `127.0.0.1:8189`; ComfyUI stays on the internal Compose network. The gateway also joins a separate bridge ingress network because Docker Desktop does not publish host ports for containers attached only to an `internal: true` network.

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

The enabled image path contains four unique files. Numbers and hashes below are the identities required
by `config/models.manifest.json`; `PENDING_VERIFICATION` remains mandatory until the downloaded bytes
pass the local verifier.

| File | Official source revision | Exact bytes | Required SHA-256 | License | Runtime path |
| --- | --- | ---: | --- | --- | --- |
| `sd_xl_base_1.0.safetensors` | `stabilityai/stable-diffusion-xl-base-1.0@462165984030d82259a11f4367a4eed129e94a7b` | 6,938,078,334 | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` | CreativeML Open RAIL++-M | `checkpoints/sd_xl_base_1.0.safetensors` |
| `control-lora-canny-rank128.safetensors` | `stabilityai/control-lora@75590eb0e7868d3d0f1581b5126d487b33c7fdb4` | 395,733,680 | `56389dbb245ca44de91d662529bd4298abc55ce2318f60bc19454fb72ff68247` | Stability AI Control-LoRA Community License | `controlnet/canny-control-lora-rank128.safetensors` |
| `control-lora-depth-rank128.safetensors` | `stabilityai/control-lora@75590eb0e7868d3d0f1581b5126d487b33c7fdb4` | 395,729,267 | `37e391757e6c0042faa3795174acbe11a31992252058cfb8bbaccf11073567b4` | Stability AI Control-LoRA Community License | `controlnet/depth-control-lora-rank128.safetensors` |
| `RealESRGAN_x4plus.pth` | `xinntao/Real-ESRGAN` release `v0.1.0`, commit `4c05b20cb30aded73ed3731848a9fbbf70c7c0ac` | 67,040,989 | `4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1` | BSD-3-Clause | `upscale_models/RealESRGAN_x4plus.pth` |

The Hugging Face file pages independently publish the SDXL and Control-LoRA SHA-256 values. The
RealESRGAN release is official, but its release page does not publish a checksum; treat the configured
hash as untrusted until `verify-models.mjs --promote` verifies the downloaded bytes. This inventory is
technical evidence, not legal advice.

1. Review `ai-engine/arch-ai-cloud-v4/config/models.manifest.json` and the pinned upstream licenses.
2. Before renting a GPU, download only these four files into a private persistent volume or an
   operator-controlled staging machine. Use the exact HTTPS URLs from the manifest; do not use `main`,
   mirrors, filename search results, or browser-renamed files.
3. Place them under `ai-engine/arch-ai-cloud-v4/runtime/models` at the exact runtime paths above.
4. Do not enable Wan 2.2.
5. Run `node ai-engine/arch-ai-cloud-v4/scripts/verify-models.mjs`; verify the expected byte count and missing list.
6. Run the same command with `--promote` only after every size and SHA-256 matches. The ignored `runtime/models.verified.manifest.json` is the only accepted READY manifest.

## Runpod packaging decision

Do not build the 12.4 GB expanded ComfyUI image during paid GPU time. A versioned registry image is
faster and more reproducible than cloning the repository and rebuilding on the Pod. Do not bake the
7.8 GB model set into a public image: it increases pull time, complicates license distribution and
prevents model storage from being reused independently.

There is one mandatory deployment checkpoint: Docker V4 is currently a two-service Compose stack
(`comfyui` plus `ai-gateway`), while a Runpod custom Pod template specifies one container image.
Runpod's documented template fields do not deploy this Compose file or two sibling containers.
Therefore the two locally built images are suitable for a Compose-capable GPU host, but **not yet a
complete Runpod Pod artifact**. Do not rent a GPU until one of these has passed local review:

1. Preferred: add and smoke-test one Runpod-specific application image that supervises the same
   pinned ComfyUI and authenticated gateway while preserving process isolation, model verification,
   non-root execution, signal handling and the rule that port 8188 is never exposed; or
2. Use a provider/instance that supplies a real Docker host and run the existing Compose stack
   unchanged. Do not assume nested Docker or privileged mode exists inside a Runpod Pod.

After a single-image artifact exists, publish it to a private registry under an immutable commit tag
and record its OCI digest. Runpod supports a custom image plus registry credentials; never use
`:latest`. Keep models on an encrypted volume disk for a one-Pod acceptance, or a standard network
volume when reuse across replacement Pods justifies the continuing storage charge.

The website path has a second independent boundary: `@archrender/ai-worker` is a long-running control
plane process and cannot run in Vercel request functions. For one acceptance render, run it from an
operator-controlled host through an SSH tunnel to the private gateway. Only that worker receives the
database/R2 configuration; the GPU runtime does not. A durable production worker deployment requires
its own later approval.

### Registry preparation after commit

These commands publish the existing two images for a Compose-capable host; they do not resolve the
single-image Runpod checkpoint. Replace only the registry owner placeholder and authenticate without
putting the token on the command line.

```powershell
$Commit = (git rev-parse --short=12 HEAD).Trim()
$RegistryOwner = '<github-owner-lowercase>'
docker login ghcr.io -u $RegistryOwner
docker tag archrender/comfyui:v4-comfyui-0.36.0 "ghcr.io/$RegistryOwner/archrender-comfyui:$Commit"
docker tag archrender/ai-gateway:v4-python-3.12.12 "ghcr.io/$RegistryOwner/archrender-ai-gateway:$Commit"
docker push "ghcr.io/$RegistryOwner/archrender-comfyui:$Commit"
docker push "ghcr.io/$RegistryOwner/archrender-ai-gateway:$Commit"
docker image inspect "ghcr.io/$RegistryOwner/archrender-comfyui:$Commit" --format '{{json .RepoDigests}}'
docker image inspect "ghcr.io/$RegistryOwner/archrender-ai-gateway:$Commit" --format '{{json .RepoDigests}}'
```

PASS requires immutable digests for both images and a private-registry pull test. FAIL if a mutable
tag is used, registry credentials appear in logs, or either digest differs from the reviewed image.

## Manual Runpod checklist (no action performed by this guide)

1. Resolve the single-image checkpoint above and push that reviewed image before starting billable
   compute. Create a private Runpod template using the immutable tag/digest and registry credential.
2. Select one Secure Cloud RTX 4090 (24 GB VRAM), at least 40 GB host RAM, 80 GB disk and CUDA >=12.4.
   Set automatic termination to no more than 60 minutes; the harness remains capped at 45 minutes and
   USD 1.00. Abort if the live quote exceeds the cap.
3. Mount verified models read-only at the image's documented model root. Use 8 GB shared memory.
   Expose SSH only for the tunnel; do not expose ComfyUI 8188. If the gateway must use Runpod HTTP
   proxy, expose only its authenticated port and account for the proxy's 100-second request limit.
4. Store the worker token with Runpod secrets or an operator-owned mode-0600 environment file. Do not
   give the GPU container database, R2, browser-session or Vercel credentials.
5. Before execution, require `nvidia-smi`, `torch.cuda.is_available() == True`, runtime pin PASS,
   model verification 4/4, gateway health READY, auth-denial PASS, zero recovery obligations and a
   fresh live-cost calculation under the hard cap.
6. Start the SSH tunnel and the separately controlled `@archrender/ai-worker` only after all preflight
   checks pass. Submit one synthetic website job, verify the immutable output checksum and stop on the
   first unexpected error; never retry the paid acceptance automatically.
7. Copy only redacted evidence, stop the worker, reconcile exact recovery identities, terminate the
   Pod, delete any acceptance-only volume and confirm billing stopped. A stopped Pod is not cleanup.

PASS means one website-created job reaches `SUCCEEDED`, its verified immutable output is readable by
the owner, cleanup obligations are zero and the Pod/temporary volume are gone. FAIL means any model,
CUDA, auth, owner isolation, checksum, timeout, cost-cap, recovery or termination check is uncertain.

## Boot and health checks

```bash
nvidia-smi
docker version
docker compose -f ai-engine/arch-ai-cloud-v4/docker-compose.yml config --quiet
docker compose -f ai-engine/arch-ai-cloud-v4/docker-compose.yml up --build --detach --wait
curl --fail http://127.0.0.1:8189/healthz
```

Inside the ComfyUI container, `verify-runtime.py` must confirm the pinned commit, PyTorch 2.6.0 and the expected CUDA/cuDNN build metadata before startup. The paid-GPU boot check must separately prove that CUDA is available and the assigned device is usable. A process-only health response is insufficient if models are not verified.

## Local Docker verification (2026-10-16)

- Docker Desktop 4.95.0 / Engine 29.8.2 ran Linux containers through WSL2 with BuildKit enabled.
- The gateway and pinned ComfyUI images built successfully. The ComfyUI image is 12,401,459,019 bytes, runs as `10001:10001`, and passed the non-GPU runtime pin check.
- Gateway Compose smoke passed on localhost: health was correctly `DEGRADED` with no ComfyUI upstream and an unauthenticated request returned 401.
- The worker's disconnected-mode boot passed without connecting to a database, queue or object storage.
- Full ComfyUI/CUDA boot was intentionally not attempted: this host exposes no usable NVIDIA device, has about 16 GB host RAM, and has none of the four verified model artifacts. Real GPU behavior remains an acceptance blocker, not a local failure.

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
