# ArchRender AI — Implementation status

Last verified: 2026-10-16. Status reflects evidence in this repository; mock/static tests are not GPU acceptance.

| Area | Status | Evidence / remaining work |
| --- | --- | --- |
| Authentication, OWNER RBAC, CSRF | PASS | PostgreSQL-backed session, origin guard and owner-scoped services have unit/integration coverage. |
| Projects | PASS | CRUD, archive/restore, optimistic concurrency and owner isolation use PostgreSQL. |
| Private asset storage | PASS (development) | Immutable R2 upload, verification, thumbnails and exact cleanup have completed controlled development acceptance. |
| Job creation and history | PASS | Image/Video Studio submit versioned jobs. Job History handles empty/data/error/timeout; project selector now uses the validated 24-row limit. |
| PostgreSQL queue concurrency | PASS | Exact-job two-worker integration proves one lease; generation and token hash fence stale workers. |
| Worker orchestration | PASS (mock) | Immutable input materialization, private gateway execution, bounded output commit and exact input cleanup pass with fake R2/ComfyUI. |
| Docker V4 static contract | PASS | Pinned ComfyUI/PyTorch/CUDA runtime, private gateway, health checks, non-root/read-only containers and Compose validation. |
| Model files | BLOCKED | Four image artifacts are absent locally and remain `PENDING_VERIFICATION`; no large download was authorized. |
| SDXL/ControlNet/Upscale GPU execution | NOT VERIFIED | Requires one approved paid RTX 4090 run. PLAN-only acceptance is ready. |
| Wan 2.2 video | BLOCKED | Disabled: exact bundle, checksums, node graph and 24 GB VRAM compatibility are not verified. |
| GPU Manager telemetry | NOT IMPLEMENTED | UI is explicitly `DISCONNECTED`/Demo; no durable worker registry or provider provisioning backend exists. |
| Production deployment | NOT VERIFIED | No push, Vercel deployment, RunPod provisioning or production mutation was performed in this work. |

## Confirmed fixes in this pass

- The former 3/4 Jobs integration result did not prove duplicate leasing: two unscoped workers could claim two different jobs from the shared development queue. The integration now scopes both contenders to the exact synthetic job and passes 4/4 without changing production queue selection.
- A fenced worker that loses its lease while reporting failure no longer terminates the complete polling process. Database/transport failures still propagate and fail closed.
- Added a mock end-to-end worker test covering immutable object identity, conditional storage read, private gateway staging, workflow execution, output commit, queue completion and exact staged-input cleanup.
- Patched transitive Prisma CLI advisories with pnpm overrides for `deepmerge-ts` and `mysql2`.

## Capability boundary

The real system boundary currently ends at an offline-validated GPU stack. A successful architectural render may only be claimed after the operator verifies model bytes, starts Docker V4 on an approved GPU, runs the bounded image acceptance, connects the database worker, and observes an immutable output in R2 and the website.
