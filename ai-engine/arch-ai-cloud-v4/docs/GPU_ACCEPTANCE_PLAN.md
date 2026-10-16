# Phase 3 GPU acceptance plan

Status: preparation only. No provider instance, model download, Docker build, R2 request, or paid
operation is performed by this plan. Price and registry evidence below was checked on 2026-10-16.

## Runtime and model decision

- ComfyUI is pinned to official release `v0.36.0`, commit
  `ee71d5c4993f29086b27fde1629a945ae48425bf`.
- The immutable base is PyTorch 2.6.0, CUDA runtime 12.4 and cuDNN 9. CUDA 12.x minor
  compatibility needs Linux driver >=525.60.13; prefer the CUDA 12.4 GA driver baseline
  >=550.54.14. Boot verification checks the actual commit and Python runtime before ComfyUI starts.
- No custom nodes are installed. SDXL img2img, ControlNet loading and RealESRGAN upscale use core
  ComfyUI nodes. Canny/depth maps are prepared inputs; runtime preprocessors are intentionally absent.
- Image order is SDXL img2img, Control-LoRA Canny, Control-LoRA Depth, then RealESRGAN x4plus.
  Wan 2.2 is `DISABLED` until a separate video checkpoint proves the real node graph and every file.

Expected image weights total 7,796,582,270 bytes (the SDXL checkpoint is referenced twice but stored
once). Registry checksums in `config/models.manifest.json` remain `PENDING_VERIFICATION`; only
`scripts/verify-models.mjs --promote` can write the ignored runtime READY manifest after local byte
size and streaming SHA-256 verification.

## License position (technical inventory, not legal advice)

| Artifact | Source/license | Commercial position |
|---|---|---|
| SDXL base 1.0 | Stability AI, CreativeML Open RAIL++-M | Permitted subject to license/use restrictions and downstream notices. |
| Control-LoRA rank-128 Canny/Depth | Stability AI Control-LoRA Community License | Permitted with conditions; commercial use above 1M monthly active users requires a separate Stability AI license. |
| RealESRGAN x4plus | xinntao/Real-ESRGAN, BSD-3-Clause (license commit `0573f32d`) | Permitted with attribution/license preservation; the license commit post-dates the v0.1.0 asset tag by three days, so retain both records. |
| Wan 2.2 candidate | Wan-AI / Comfy-Org repack, Apache-2.0 | License identified, but exact bundle/revision/checksums and workflow compatibility are not accepted; video remains disabled. |

## Provider comparison and recommendation

These are snapshots, not reservations. Availability and the final checkout quote must be captured
immediately before rental.

| Item | RunPod | Vast.ai |
|---|---|---|
| RTX 3090 / 24 GB | Secure Pods published at USD 0.50/hour. | Marketplace snapshot showed verified one-GPU offers from about USD 0.152/hour plus host-specific bandwidth/storage. |
| RTX 4090 / 24 GB | Secure Pods published at USD 0.89/hour; Community examples from USD 0.34/hour. | Marketplace snapshot showed verified one-GPU offers around USD 0.366-0.940/hour plus bandwidth; prices are host-specific. |
| Persistent storage | Container/volume disk USD 0.10/GB/month; idle volume USD 0.20/GB/month; standard network volume USD 0.07/GB/month under 1 TB. Published product page states no ingress/egress fee. | Storage and upload/download prices vary per offer and remain billable while stopped; exact quote required. |
| Stop behavior | Stopping releases the GPU but storage remains billed; restart on the same GPU is not guaranteed. Delete the Pod after evidence is copied. | Compute stops billing when inactive, but storage and bandwidth charges remain; delete the instance after evidence is copied. |
| Startup time | No contractual time verified; product copy says minutes. Treat as UNKNOWN and include it in the wall clock cap. | Product copy says roughly 60 seconds, but no contractual guarantee. Treat as UNKNOWN. |

Recommendation: one RunPod Secure Cloud RTX 4090 (24 GB VRAM, published configuration 41 GB RAM),
80 GB container disk, no network volume, one Pod, one image acceptance run. It costs more than a
low Vast offer but provides a published fixed rate and zero-egress statement, simplifying the first
security acceptance. At USD 0.89/hour, 45 minutes is USD 0.6675 compute. The enforced total hard cap
is USD 1.00 including any fixed/storage charge entered by the operator. Abort before start if the
checkout quote or computed cap exceeds this. A 3090 is viable but slower; use it only after a fresh
quote and keep the same cap.

## Capacity and build checklist

- GPU: exactly one NVIDIA RTX 4090, 24 GB VRAM; `nvidia-smi` visible; driver >=550.54.14 preferred.
- RAM: 32 GB container limit, at least 40 GB host RAM; 8 GB shared memory. No swap dependence.
- Disk: 50 GB absolute minimum, 80 GB recommended. The verified compressed base layers total
  3,314,094,972 bytes. Final V4 pull/build size is UNKNOWN until built; estimate 4-6 GB compressed,
  10-14 GB expanded, plus 7.8 GB weights and bounded temporary/output space.
- Verify exact base digest, ComfyUI commit, runtime pin, zero custom nodes, model files and licenses.
- Use `Dockerfile.runpod` on RunPod. ComfyUI stays on container loopback; expose only the
  authenticated gateway on port 8080 through the provider HTTPS proxy.
- Run `docker compose config --quiet`; never inject database, R2, session or provider credentials.
- ENOMEM response: stop new submissions, capture only redacted phase/status, cancel the exact job,
  bring down the dedicated Compose project, and terminate the Pod. Do not add a second GPU or retry
  at a lower integrity setting. A later approved run may reduce resolution/steps within product limits.

## One bounded image acceptance

Run `node scripts/gpu-image-acceptance.mjs` first (PLAN only). After separate paid-operation approval,
set the development/approval/cost environment guards and run with `--execute`. The harness:

1. validates three synthetic 1024x1024 fixtures and their SHA-256 values;
2. verifies all expected model bytes, writes a durable promoted manifest, then durably records exact
   target, staged input and output recovery identities before each mutation;
3. enforces a 45-minute wall cap and USD 1.00 computed cap;
4. tests gateway auth denial, sequential SDXL img2img, Canny, Depth and x4 upscale;
5. validates PNG magic, byte bounds, dimensions and checksums, and saves ignored local evidence;
6. deletes staged inputs by exact workspace/name/checksum, destroys only dedicated local Compose
   volumes for the Compose target, and removes the recovery manifest only at zero obligations.

For RunPod set `GPU_ACCEPTANCE_TARGET=runpod` and an HTTPS `AI_ENGINE_GATEWAY_URL`. The harness does
not start or stop the remote Pod. It remains bounded to four sequential jobs, a 45-minute wall cap
and the operator-supplied USD 1.00 hard cap. Pod and volume teardown are manual fail-closed steps.

Manual output acceptance uses `fixtures/golden-courtyard.criteria.json`: score at least 8/10, preserve
the two wings, perspective, window groups, doorway/tree/paving positions, and reject collapsed or
duplicated geometry. Redacted logs contain event/scenario/status/count/timing only; they never contain
tokens, provider credentials, URLs with credentials, raw prompts, or model paths.

Provider termination is deliberately outside the repository: after the harness stops, copy only the
evidence JSON and synthetic result images, verify zero recovery obligations, stop and then delete the
exact Pod, confirm it disappears from the provider console, confirm no volume remains, and record the
final billing amount. A stopped Pod is not considered terminated.

## Separate video checkpoint

Do not combine video with image acceptance. Before Wan 2.2 approval, pin the exact Comfy-Org bundle
revision and every required diffusion model, text encoder, VAE and CLIP artifact with size/SHA-256;
compile the official core-node API workflow; measure real VRAM/disk; select a >=48 GB GPU; define a
short <=5 second synthetic fixture and a separate cost cap. Current Wan bundle size is approximately
126 GB at the repository level, so it does not fit this image-run disk or budget. Until those items
pass review, video is `DISABLED` and the current `WanImageToVideo` template is unaccepted.

## Evidence sources

- ComfyUI release: https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.36.0
- PyTorch 2.6 CUDA 12.4: https://docs.pytorch.org/get-started/previous-versions/
- CUDA compatibility: https://docs.nvidia.com/cuda/archive/12.4.0/cuda-toolkit-release-notes/
- SDXL: https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0
- Control-LoRA: https://huggingface.co/stabilityai/control-lora
- RealESRGAN: https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0
- Wan 2.2: https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged
- RunPod pricing: https://www.runpod.io/pricing
- Vast pricing and billing: https://vast.ai/pricing and https://console.vast.ai/faq/
