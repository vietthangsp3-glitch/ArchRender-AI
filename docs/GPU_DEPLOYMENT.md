# GPU deployment — RunPod RTX 4090

Status: offline packaging is complete. This guide does not push an image, download models, create a
RunPod resource, run a GPU job, mutate a production database or call R2.

## Accepted topology

- Development remains the two-container Compose stack (`comfyui` + `ai-gateway`).
- RunPod uses one image built from `Dockerfile.runpod`. `tini` starts a supervisor; the supervisor
  starts ComfyUI on container loopback `127.0.0.1:8188`, waits for readiness, then starts the
  authenticated gateway on port 8080. If either child exits, both stop. SIGTERM has a 30-second
  graceful window.
- The root entrypoint only prepares `/workspace/archrender`; long-running processes use UID/GID
  10001. Model files and mutable state stay on the mounted volume, never in the image.
- The GPU image contains no queue worker and receives no database, R2, Vercel session or browser
  credentials. Run `@archrender/ai-worker` separately only after explicit configuration.
- Default mode is `blocked`. `smoke` is local CPU-only. `acceptance` requires exactly one CUDA device,
  at least 22 GiB VRAM and all four model files to pass byte-size/SHA-256 verification.

## Build and local verification

Run from the repository root in PowerShell. No model files or GPU are required.

```powershell
docker build --file ai-engine/arch-ai-cloud-v4/Dockerfile.comfyui `
  --tag archrender/comfyui:v4-comfyui-0.36.0 ai-engine/arch-ai-cloud-v4

docker build --build-arg COMFYUI_IMAGE=archrender/comfyui:v4-comfyui-0.36.0 `
  --file ai-engine/arch-ai-cloud-v4/Dockerfile.runpod `
  --tag archrender/runpod:v4-local ai-engine/arch-ai-cloud-v4

docker run --detach --name archrender-runpod-smoke `
  --mount type=volume,source=archrender-runpod-smoke-workspace,target=/workspace `
  --publish 127.0.0.1:18080:8080 `
  --env ARCHRENDER_RUNPOD_MODE=smoke `
  --env AI_ENGINE_WORKER_TOKEN='<temporary-random-value-at-least-32-characters>' `
  --memory 8g --shm-size 2g archrender/runpod:v4-local

docker inspect archrender-runpod-smoke --format '{{.State.Health.Status}}'
Invoke-RestMethod http://127.0.0.1:18080/healthz
docker port archrender-runpod-smoke
docker top archrender-runpod-smoke -eo pid,user,args
docker stop --timeout 35 archrender-runpod-smoke
docker rm archrender-runpod-smoke
docker volume rm archrender-runpod-smoke-workspace
```

PASS means health is `healthy`/`READY`, only 8080 maps to localhost, children use UID 10001, an
unauthenticated execution request returns 401, stop exits 0 and exact resources are removed. The
image build contains a version-gated fix for the confirmed PyTorch 2.6 / comfy-kitchen 0.2.34
custom-op annotation issue; it fails closed if versions or patch targets change.

## Private registry workflow

Use one immutable commit tag; never use `latest`. Authenticate interactively or via secure stdin.
Never place a registry token in command history or a build argument.

```powershell
$Commit = (git rev-parse --short=12 HEAD).Trim()
$RegistryOwner = 'vietthangsp3-glitch'
$Image = "ghcr.io/$RegistryOwner/archrender-ai-runpod:$Commit"
docker tag archrender/runpod:v4-local $Image
docker login ghcr.io -u $RegistryOwner
docker push $Image
docker buildx imagetools inspect $Image
```

Record the registry-reported `sha256:...` manifest digest. Configure RunPod with
`ghcr.io/vietthangsp3-glitch/archrender-ai-runpod@sha256:<verified-digest>`, not the tag, and perform one
private pull test. Enter registry credentials only in RunPod's private-registry credential fields.
The local Docker digest is build evidence, not proof of the future registry digest.

### Large-layer and GHCR 502 recovery

The pinned PyTorch base contains one compressed `3,276,447,764` byte layer
(`sha256:fadd8cccba885ca0a6bbf8c135d31d0d2ebd9e7fae7dabaa66475012cea2a4ca`). Its Docker history
instruction is the upstream `COPY /opt/conda /opt/conda`; the uncompressed layer is about 6.11 GB
and contains the pinned PyTorch/CUDA/cuDNN runtime. It cannot be split or made smaller by a child
Dockerfile without rebasing/repacking that runtime and invalidating its verified digest. Do not use
`--no-cache`, flatten the image, or remove runtime libraries to work around a registry error.

If `docker push` reports HTTP 502 after uploading a large layer, keep the same local image and tag.
First check whether GHCR committed the manifest, then repeat the identical push only when the
manifest is absent. Content-addressed layers that GHCR already committed are reused.

```powershell
$Commit = (git rev-parse --short=12 HEAD).Trim()
$Image = "ghcr.io/vietthangsp3-glitch/archrender-ai-runpod:$Commit"

docker buildx imagetools inspect $Image
# If the tag is absent, retry exactly once without rebuilding or retagging:
docker push $Image
docker buildx imagetools inspect $Image
```

After a successful push, record the registry digest and use the digest-pinned reference in the
RunPod template. As long as the pinned PyTorch base digest remains unchanged, later application
images reuse the existing large base layer instead of uploading it again.

## Four required model artifacts

Total unique bytes: 7,796,582,270. Download only from each exact `sourceUrl` and revision in
`ai-engine/arch-ai-cloud-v4/config/models.manifest.json`; never use `main`, mirrors or renamed files.

| Runtime path below `/workspace/archrender/models` | Bytes | Required SHA-256 | License position |
| --- | ---: | --- | --- |
| `checkpoints/sd_xl_base_1.0.safetensors` | 6,938,078,334 | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` | CreativeML Open RAIL++-M; restrictions apply |
| `controlnet/canny-control-lora-rank128.safetensors` | 395,733,680 | `56389dbb245ca44de91d662529bd4298abc55ce2318f60bc19454fb72ff68247` | Stability AI Control-LoRA Community License; restrictions apply |
| `controlnet/depth-control-lora-rank128.safetensors` | 395,729,267 | `37e391757e6c0042faa3795174acbe11a31992252058cfb8bbaccf11073567b4` | Stability AI Control-LoRA Community License; restrictions apply |
| `upscale_models/RealESRGAN_x4plus.pth` | 67,040,989 | `4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1` | BSD-3-Clause |

Upstream publishes the SDXL and Control-LoRA file hashes. The official RealESRGAN v0.1.0 release
does not publish a checksum, so its recorded hash remains untrusted until downloaded bytes pass
verification. This is a technical inventory, not legal advice. Wan 2.2 remains disabled.

On an operator-controlled Linux shell or mounted RunPod volume, use the pinned URLs below. These
commands are manual and intentionally not executed by repository startup:

```bash
set -euo pipefail
root=/workspace/archrender/models
install -d -m 0755 "$root/checkpoints" "$root/controlnet" "$root/upscale_models"
curl --fail --location --retry 2 --output "$root/checkpoints/sd_xl_base_1.0.safetensors" \
  'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors'
curl --fail --location --retry 2 --output "$root/controlnet/canny-control-lora-rank128.safetensors" \
  'https://huggingface.co/stabilityai/control-lora/resolve/75590eb0e7868d3d0f1581b5126d487b33c7fdb4/control-LoRAs-rank128/control-lora-canny-rank128.safetensors'
curl --fail --location --retry 2 --output "$root/controlnet/depth-control-lora-rank128.safetensors" \
  'https://huggingface.co/stabilityai/control-lora/resolve/75590eb0e7868d3d0f1581b5126d487b33c7fdb4/control-LoRAs-rank128/control-lora-depth-rank128.safetensors'
curl --fail --location --retry 2 --output "$root/upscale_models/RealESRGAN_x4plus.pth" \
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
sha256sum \
  "$root/checkpoints/sd_xl_base_1.0.safetensors" \
  "$root/controlnet/canny-control-lora-rank128.safetensors" \
  "$root/controlnet/depth-control-lora-rank128.safetensors" \
  "$root/upscale_models/RealESRGAN_x4plus.pth"
stat --format='%n %s' \
  "$root/checkpoints/sd_xl_base_1.0.safetensors" \
  "$root/controlnet/canny-control-lora-rank128.safetensors" \
  "$root/controlnet/depth-control-lora-rank128.safetensors" \
  "$root/upscale_models/RealESRGAN_x4plus.pth"
chmod 0444 "$root/checkpoints/sd_xl_base_1.0.safetensors" \
  "$root/controlnet/canny-control-lora-rank128.safetensors" \
  "$root/controlnet/depth-control-lora-rank128.safetensors" \
  "$root/upscale_models/RealESRGAN_x4plus.pth"
```

Compare all four `sha256sum` and `stat` results with the table before starting acceptance. A partial
download, redirect to an HTML error document, byte-count mismatch or checksum mismatch is FAIL; do
not rename, promote or use the file.

Prefer an encrypted RunPod network volume in the same data center, populated once by an
operator-controlled transfer. Otherwise mount a 50-GB Pod volume at `/workspace` and download during
the single Pod session. Create the exact directories, verify size and `sha256sum`, then keep files
root-owned and non-writable by UID 10001. Never bake weights into the image. Acceptance repeats
streaming verification and atomically writes:

```text
/workspace/archrender/state/models.verified.manifest.json
```

## RunPod template contract

Create one private custom Pod template:

| Field | Value / rule |
| --- | --- |
| Container image | Private registry image by immutable digest |
| Start command | Blank; use the image entrypoint |
| GPU | Exactly 1 x RTX 4090, 24 GB VRAM |
| Host RAM | At least 40 GB (published configuration: 41 GB) |
| Container disk | 30 GB minimum for image/layers |
| Persistent/network volume | 50 GB minimum mounted at `/workspace`; 80 GB if retaining outputs |
| Shared memory | 8 GB |
| HTTP ports | Expose only `8080`; never expose `8188` |
| TCP/SSH | Disabled unless needed; key authentication only |
| Restart | No automatic retry during acceptance |
| Auto-termination | 60 minutes maximum; manual deletion after evidence collection |

RunPod's HTTP proxy is internet reachable and has a 100-second request limit. Bearer authentication
is mandatory and ComfyUI remains unreachable. Never place the token in a URL. Use
`https://<pod-id>-8080.proxy.runpod.net` only from the controlled worker/acceptance client.

Template environment variable names:

```text
ARCHRENDER_RUNPOD_MODE=acceptance
ARCHRENDER_PERSIST_ROOT=/workspace/archrender
ARCHRENDER_GATEWAY_EXPOSURE=runpod_proxy
AI_ENGINE_GATEWAY_BIND_HOST=0.0.0.0
AI_ENGINE_GATEWAY_PORT=8080
AI_ENGINE_WORKER_TOKEN=<RunPod secret, at least 32 random characters>
AI_ENGINE_MAX_REQUEST_BYTES=1048576
AI_ENGINE_MAX_INPUT_BYTES=104857600
AI_ENGINE_UPSTREAM_TIMEOUT_SECONDS=30
```

Do not add `DATABASE_URL`, R2 keys, `AUTH_CONTEXT_SECRET` or Vercel credentials to this template.

## Bounded GPU acceptance

Before EXECUTE use the Pod terminal to confirm `nvidia-smi`, healthy status, the safe
`runpod_model_verification PASS` event, unauthenticated gateway denial and zero recovery obligations.
For the RunPod target, the harness fetches the small promoted manifest through the authenticated
Gateway, verifies every model/artifact identity against the committed source manifest, confirms Wan
remains disabled and atomically writes the ignored
`runtime/models.verified.runpod.json`. Local model weights are not required on the worker host.

First run PLAN:

```powershell
$env:GPU_ACCEPTANCE_TARGET='runpod'
$env:AI_ENGINE_GATEWAY_URL='https://<pod-id>-8080.proxy.runpod.net'
$env:GPU_ACCEPTANCE_MAX_RUNTIME_MINUTES='45'
$env:GPU_ACCEPTANCE_HARD_COST_CAP_USD='1.00'
$env:GPU_ACCEPTANCE_QUOTED_HOURLY_USD='<live-checkout-rate>'
$env:GPU_ACCEPTANCE_FIXED_COST_USD='<known-storage-charge-for-window>'
node ai-engine/arch-ai-cloud-v4/scripts/gpu-image-acceptance.mjs
```

Only after separate paid-operation approval set
`GPU_ACCEPTANCE_APPROVAL=PHASE3_IMAGE_ACCEPTANCE_APPROVED` and add `--execute` exactly once. The
harness is limited to four sequential synthetic jobs (SDXL img2img, Canny, Depth, RealESRGAN), one
gateway, 45 minutes, USD 1.00, exact identities and no automatic cloud retry.

After engine acceptance start the worker from an operator-controlled host:

```powershell
$env:AI_ENGINE_MODE='private'
$env:AI_ENGINE_GATEWAY_URL='https://<pod-id>-8080.proxy.runpod.net'
$env:AI_ENGINE_MODEL_MANIFEST_PATH='ai-engine/arch-ai-cloud-v4/runtime/models.verified.runpod.json'
$env:AI_ENGINE_WORKER_ID='archrender_runpod_acceptance_01'
$env:AI_ENGINE_AVAILABLE_NODES='<exact comma-separated core nodes from the manifest>'
pnpm --filter @archrender/ai-worker start
```

The worker host—not the Pod—receives scoped development database/R2 variables and the same gateway
token. Submit exactly one synthetic website render; require Job History `SUCCEEDED`, an
owner-authorized R2 output with matching checksum and no orphaned lease/object.

## Cost and teardown

Official pricing checked 2026-10-16 lists Secure Cloud RTX 4090 at USD 0.89/hour. Forty-five minutes
is USD 0.6675 compute before storage. This is not a reservation: verify checkout, availability,
storage and taxes and abort if computed total exceeds USD 1.00. Startup time counts toward the cap.

On success or first failure: stop the worker, cancel only the exact execution if necessary, preserve
the recovery manifest when obligations remain, copy redacted evidence, delete the exact Pod, delete
only acceptance-only storage, and confirm resources disappear and billing stops. A stopped Pod is
not teardown. Never perform prefix/global cleanup.

## Current status

- PASS: Dockerfiles, compatibility patch, single-image build, CPU ComfyUI boot, gateway auth/health,
  loopback isolation, non-root children, graceful shutdown and exact local cleanup.
- PASS: PLAN-only four-job harness and fail-closed environment/cost/recovery guards.
- NOT VERIFIED: CUDA, real model bytes, registry pull, RunPod networking, image quality and the real
  website → worker → GPU → R2 → Job History path.
- BLOCKED: paid/cloud verification until the operator pushes the image, prepares models, creates the
  template, confirms the live quote and explicitly approves one EXECUTE run.
