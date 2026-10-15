# ArchRender AI Engine V4

V4 is isolated from `arch-ai-cloud-v3`. It exposes only an authenticated gateway on
`127.0.0.1`; ComfyUI remains on a Docker-internal network and starts with paid API
nodes disabled. The GPU runtime receives no database, R2, user-session, or browser
credentials.

## Safety defaults

- All model entries start as `PENDING_VERIFICATION`; the application refuses them.
- No model download or custom-node install occurs at container startup.
- Only allowlisted ComfyUI node classes are accepted by the gateway.
- Input/output names are local basenames; URLs, traversal, and arbitrary commands are rejected.
- Gateway execution identities are deterministic per job generation and persisted atomically on a dedicated volume.
- Containers run as UID/GID 10001, drop Linux capabilities, use read-only roots, bounded tmpfs,
  log rotation, health checks, explicit stop windows, and a single private network.
- The Compose stack defaults to `restart: no` so an operator retains the billing stop switch.

## Operator preparation (no cloud action is performed by this repository)

1. Copy `.env.example` to an operator-owned secret file outside Git and set a random worker token.
2. Re-verify the recorded immutable OCI digests before promotion; updating a tag or digest requires review.
3. Review the pinned source and license evidence in `config/models.manifest.json`. Place the image
   weights beneath `runtime/models` using exact manifest paths; this directory is ignored by Git.
4. Run `node scripts/verify-models.mjs` for a status-only plan. After obtaining the files from their
   pinned official revisions, run `node scripts/verify-models.mjs --promote`; it streams SHA-256 and
   writes `runtime/models.verified.manifest.json` only when every image artifact matches.
5. Run `docker compose config --quiet` and the focused static tests. Do not build or boot until a
   paid GPU operation is approved. `node scripts/gpu-image-acceptance.mjs` is PLAN-only by default.

`EXECUTION_RECOVERY_REQUIRED` means the durable manifest was written before the upstream mutation,
but the prompt identity was not committed. Stop the worker and reconcile that exact client identity
against the private ComfyUI queue/history; never delete the state volume or resubmit blindly.

The control-plane worker is `@archrender/ai-worker`. It defaults to `AI_ENGINE_MODE=disconnected`
and exits without claiming a job. Private mode requires an authenticated gateway, a fully verified
model manifest, an explicit node-capability list, database access and scoped R2 access. Inputs are
copied by checksum into the private engine volume and deleted by exact identity after each attempt.

## Acceptance boundary

Static validation and mock execution are not GPU acceptance. Real acceptance must use a paid-GPU
budget, synthetic fixtures, bounded jobs, provider billing caps, immutable R2 output verification,
and explicit operator approval. See `docs/GPU_ACCEPTANCE_PLAN.md`.

