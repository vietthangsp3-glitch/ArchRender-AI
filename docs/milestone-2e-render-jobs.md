# Milestone 2E — Render Jobs operations

## Migration checkpoint

The pending migration is `20261015000200_phase_2e_render_jobs_workflows`. It is backward-compatible, backfills existing workflow drafts and verified input snapshots, and uses bounded PostgreSQL lock/statement timeouts. It has **not** been applied by Codex.

Operator review and development deployment:

```powershell
pnpm db:validate
pnpm db:migrate:deploy
pnpm --filter @archrender/jobs test:integration
```

Do not use `db push`, `migrate reset`, or modify an applied migration. Before deployment, confirm there are no legacy `RenderJobInput` rows without one verified immutable `ORIGINAL`; the migration fails closed when such a row exists.

## Standalone simulation worker

The worker is manual and development-only. It never creates fake output assets and never calls a GPU or external AI service.

```powershell
pnpm --filter @archrender/jobs worker:simulate -- --execute --environment=development --scenario=success
```

Supported scenarios are `success`, `failure`, and `crash`. A crash intentionally leaves a bounded lease for a later recovery invocation through `WorkerQueueService.recoverExpired`. The CLI refuses production or calls without explicit opt-in. Polling is deliberately not embedded in Next.js or Vercel requests.

## Queue guarantees

- PostgreSQL `FOR UPDATE SKIP LOCKED` performs atomic claim with priority then FIFO ordering.
- A random lease token is returned once; only its SHA-256 hash is persisted.
- Generation plus lease-token hash fences reassigned workers.
- Completion, cancellation, retry, and lease recovery use compare-and-swap transitions.
- Jobs snapshot published workflow version, validated parameters, and immutable asset identity/checksum/ETag.
- `RenderJobInput` restrictive foreign keys prevent physical deletion of referenced originals.
- User APIs are session/owner scoped; mutations retain Origin/Host protection and bounded JSON.

## Recovery and monitoring

Run recovery from a future standalone worker on a bounded schedule, not inside a serverless request. Use batches of at most 100 and an idle backoff. Alert on growing `RETRY_SCHEDULED`, expired leases, exhausted retries, or jobs that cannot be claimed because they are legacy and lack a safe input snapshot. Never expose lease hashes or tokens in APIs or logs.
