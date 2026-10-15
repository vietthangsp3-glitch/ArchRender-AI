import "dotenv/config";
import { readdirSync } from "node:fs";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[render-jobs-migration-audit] DATABASE_URL_MISSING");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl, application_name: "archrender-2e-readiness-audit" });
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '3s'");

  const migration = await client.query(`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, ["20261015000200_phase_2e_render_jobs_workflows"]);
  const migrationState = await client.query(`SELECT
    count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,
    count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS failed_or_incomplete
    FROM "_prisma_migrations"`);
  const jobs = await client.query(`SELECT "status"::text AS status, count(*)::int AS count FROM "RenderJob" GROUP BY "status" ORDER BY "status"::text`);
  const totals = await client.query(`SELECT
    (SELECT count(*)::int FROM "RenderJob") AS render_jobs,
    (SELECT count(*)::int FROM "RenderJobInput") AS render_inputs,
    (SELECT count(*)::int FROM "RenderJobOutput") AS render_outputs,
    (SELECT count(*)::int FROM "RenderJobEvent") AS render_events,
    (SELECT count(*)::int FROM "WorkflowPreset") AS workflow_presets,
    (SELECT count(*)::int FROM "WorkflowVersion") AS workflow_versions`);
  const violations = await client.query(`SELECT
    (SELECT count(*)::int FROM "RenderJob" job JOIN "Project" project ON project."id" = job."projectId" WHERE job."ownerId" <> project."ownerId") AS cross_owner_job_project,
    (SELECT count(*)::int FROM "RenderJob" job JOIN "WorkflowVersion" version ON version."id" = job."workflowVersionId" WHERE job."ownerId" <> version."ownerId") AS cross_owner_job_workflow,
    (SELECT count(*)::int FROM "RenderJobEvent" event JOIN "RenderJob" job ON job."id" = event."jobId" WHERE event."ownerId" <> job."ownerId") AS cross_owner_job_event,
    (SELECT count(*)::int FROM "RenderJobOutput" output JOIN "RenderJob" job ON job."id" = output."jobId" JOIN "Asset" asset ON asset."id" = output."assetId" WHERE job."ownerId" <> asset."ownerId") AS cross_owner_job_output,
    (SELECT count(*)::int FROM "WorkflowPreset" preset JOIN "Project" project ON project."id" = preset."projectId" WHERE preset."ownerId" <> project."ownerId") AS cross_owner_preset_project,
    (SELECT count(*)::int FROM "WorkflowVersion" version JOIN "WorkflowPreset" preset ON preset."id" = version."presetId" WHERE version."ownerId" <> preset."ownerId") AS cross_owner_version_preset,
    (SELECT count(*)::int FROM "RenderJob" WHERE jsonb_typeof("parameters") IS DISTINCT FROM 'object') AS invalid_job_parameters_shape,
    (SELECT count(*)::int FROM "WorkflowVersion" WHERE jsonb_typeof("parameters") IS DISTINCT FROM 'object') AS invalid_workflow_parameters_shape`);
  const backfill = await client.query(`SELECT
    count(*)::int AS total_inputs,
    count(*) FILTER (WHERE object."id" IS NULL)::int AS inputs_without_verified_original
    FROM "RenderJobInput" input
    JOIN "RenderJob" job ON job."id" = input."jobId"
    LEFT JOIN "AssetStorageObject" object ON object."assetId" = input."assetId" AND object."ownerId" = job."ownerId" AND object."role" = 'ORIGINAL' AND object."state" = 'VERIFIED' AND object."deletedAt" IS NULL`);
  const compatibility = await client.query(`SELECT
    count(*) FILTER (WHERE input_count = 0)::int AS jobs_without_inputs,
    count(*) FILTER (WHERE input_count = 0 AND status IN ('CREATED', 'UPLOADING', 'QUEUED', 'PROVISIONING', 'RUNNING'))::int AS active_legacy_jobs_without_inputs
    FROM (SELECT job."status"::text AS status, count(input."jobId")::int AS input_count FROM "RenderJob" job LEFT JOIN "RenderJobInput" input ON input."jobId" = job."id" GROUP BY job."id", job."status") state`);
  const workflowVersions = await client.query(`SELECT count(*)::int AS preset_version_counter_mismatches FROM "WorkflowPreset" preset LEFT JOIN (SELECT "presetId", max("version")::int AS max_version FROM "WorkflowVersion" GROUP BY "presetId") version ON version."presetId" = preset."id" WHERE preset."currentVersionNumber" <> COALESCE(version.max_version, 0)`);
  const sizes = await client.query(`SELECT
    pg_total_relation_size('"RenderJob"')::bigint::text AS render_job_bytes,
    pg_total_relation_size('"RenderJobInput"')::bigint::text AS render_input_bytes,
    pg_total_relation_size('"WorkflowVersion"')::bigint::text AS workflow_version_bytes`);
  const integrationFixtures = await client.query(`SELECT count(*)::int AS remaining_m2e_test_owners FROM "User" WHERE "email" ~ '^m2e-.*@integration\\.invalid$'`);

  await client.query("ROLLBACK");
  process.stdout.write(`${JSON.stringify({
    migrationAppliedCount: migration.rows[0]?.count ?? 0,
    migrationState: { ...migrationState.rows[0], local: readdirSync(new URL("../prisma/migrations", import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length },
    totals: totals.rows[0],
    jobStatusCounts: jobs.rows,
    violations: violations.rows[0],
    backfill: backfill.rows[0],
    compatibility: compatibility.rows[0],
    workflowVersioning: workflowVersions.rows[0],
    relationSizesBytes: sizes.rows[0],
    integrationFixtures: integrationFixtures.rows[0],
  }, null, 2)}\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  console.error(`[render-jobs-migration-audit] READ_ONLY_QUERY_FAILED code=${code}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
