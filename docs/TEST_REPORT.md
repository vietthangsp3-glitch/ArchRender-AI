# Test report — 2026-10-16

## Executed in this workspace

| Gate | Result |
| --- | --- |
| Jobs unit tests after exact-scope change | PASS — 11/11 |
| Jobs PostgreSQL integration | PASS — 4/4 |
| AI engine unit/static tests | PASS — 19/19 |
| AI worker mock orchestration | PASS — 4/4 |
| Python private gateway tests | PASS — 3/3 |
| Model verification plan | PASS plan; 0/4 artifacts present, 7,796,582,270 expected bytes |
| GPU image acceptance plan | PASS plan; 4 image jobs, no provisioning, no video |
| Docker Compose config | PASS with an ephemeral placeholder token; local Docker config emitted an access warning |
| Dependency audit | PASS — no known vulnerabilities |
| Prisma schema validation | PASS |
| Workspace typecheck | PASS — 11 projects |
| Web lint | PASS — zero warnings |
| Full unit/component suite | PASS — 232/232 |
| Full PostgreSQL integration suite | PASS — 20/20 |
| Next.js production build | PASS — 20 routes generated/validated |

No real R2 call, production database mutation, Docker image build, model download or GPU execution was performed.

## Security findings

- P0: none confirmed in the offline paths tested.
- P1 fixed: shared-queue integration could claim unrelated development jobs and misreport two non-null claims as a duplicate lease. Exact-job scope now isolates the concurrency test.
- P1 fixed: `JOB_STALE_WORKER` during failure reporting could terminate the worker polling process; it is now treated as successful fencing while database/transport errors still propagate.
- P1 fixed: transitive Prisma tooling included `deepmerge-ts` and `mysql2` advisories; patched versions are enforced by pnpm overrides.
- P1 open: model files and licenses/checksums have not been verified from downloaded bytes.
- P1 open: GPU Manager is demo-only and does not expose trusted worker telemetry.
- P2 open: private gateway execution/output state retention needs measurement and a bounded cleanup policy during real GPU acceptance.

## Acceptance classification

- Backend/database queue: PASS in development integration.
- Browser-to-job API: PASS by local tests/build; production redeployment is pending.
- Worker-to-fake-engine orchestration: PASS.
- Docker V4: static PASS, build/boot NOT VERIFIED.
- Real SDXL/ControlNet/Upscale: BLOCKED pending paid GPU and model bytes.
- Wan video: BLOCKED and intentionally disabled.
