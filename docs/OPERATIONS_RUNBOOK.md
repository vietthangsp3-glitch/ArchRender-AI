# ArchRender AI operations runbook

## Normal signals

- Web: authenticated OWNER can create a project, upload a verified asset, submit a job and open `/jobs`.
- Queue: `QUEUED` jobs become `CLAIMED`, then `RUNNING`; one active lease has one worker, generation and token hash.
- Worker: emits only structured `ai_worker_status` and `ai_worker_cycle` events. Lease tokens, storage keys, signed URLs and credentials are prohibited in logs.
- Engine: `/healthz` is reachable only through the host-bound private gateway; ComfyUI port 8188 is not public.
- Output: job becomes `SUCCEEDED` only after every generated output is inspected and committed as `READY / VERIFIED_IMMUTABLE`.

## Queue recovery

1. Stop or drain the unhealthy worker.
2. Check aggregate counts for `CLAIMED`, `RUNNING`, `CANCEL_REQUESTED` and expired `leaseExpiresAt`; do not print owner/job data.
3. Run bounded `recoverExpired` from one trusted worker. It uses row locks and generation fencing.
4. A stale worker receiving `JOB_STALE_WORKER` must discard its result. Never convert it to success.
5. Alert if retry-scheduled counts grow, retries exhaust, or lease recovery repeats for the same workload.

## Engine or GPU failure

- `AI_ENGINE_DISCONNECTED` / transport / timeout: retry only through the bounded job policy.
- GPU OOM: cancel the exact execution, preserve durable gateway state and allow lease recovery. Do not relax output or model verification.
- `EXECUTION_RECOVERY_REQUIRED`: reconcile the persisted execution identity against private ComfyUI history before resubmission.
- Invalid output: retain safe error code, reject the object and never mark the job successful.

## Storage and cleanup

- Use exact object keys and verified owner/checksum identities only.
- No bucket listing, prefix deletion or global cleanup in incident handling.
- Run maintenance dry-run first with explicit environment confirmation and bounded batch size.
- If R2 mutation succeeded but database commit failed, retry the same durable output identity; do not allocate another final key.

## Job History incident

- Route render failure is handled by the `/jobs` error boundary with retry.
- API requests time out client-side after 15 seconds and show sanitized 401/403/500/network codes.
- An empty owner-scoped list must show `Chưa có lịch sử xử lý`; it is not an error.
- Validate the project selector page size against the ProjectService maximum (currently 24) before deployment.

## Release checklist

1. Review `git diff`, untracked files and secret/large-binary scan.
2. `pnpm db:validate`, typecheck, lint, unit tests, approved development integrations and production build.
3. Do not run migrations in Vercel build. Apply reviewed migrations separately.
4. Deploy staging first, validate auth/origin settings, then smoke-test Project, Asset, Image Studio and Job History.
5. GPU deployment and real R2 acceptance require separate explicit authorization.

## Escalation / stop conditions

Stop mutation and preserve recovery evidence for checksum mismatch, unknown object identity, duplicate final output with different bytes, cross-owner reference, unbounded retry, database migration mismatch, or unknown provider billing state.
