import { config as loadEnvironment } from "dotenv";
import pg from "pg";

loadEnvironment({ path: new URL("../.env", import.meta.url), quiet: true });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  const result = await client.query(`
    WITH scoped_owners AS (
      SELECT id
      FROM "User"
      WHERE role::text = 'OWNER'
        AND email NOT LIKE '%@integration.invalid'
        AND email NOT LIKE '%@example.invalid'
    ), sessions AS (
      SELECT
        asset."ownerId",
        asset.status::text AS status,
        asset."uploadExpiresAt",
        asset."verificationStartedAt",
        asset."storageLayout"::text AS storage_layout,
        EXISTS (
          SELECT 1
          FROM "AssetStorageObject" object
          WHERE object."assetId" = asset.id
            AND object."ownerId" = asset."ownerId"
            AND object.role::text = 'STAGING'
            AND object.state::text <> 'DELETED'
        ) AS has_staging_identity
      FROM "Asset" asset
      JOIN scoped_owners owner_scope ON owner_scope.id = asset."ownerId"
      WHERE asset."deletedAt" IS NULL
        AND asset.status::text IN ('PENDING_UPLOAD', 'VERIFYING')
    )
    SELECT
      COUNT(DISTINCT "ownerId")::int AS owners_with_sessions,
      COUNT(*) FILTER (WHERE status = 'PENDING_UPLOAD')::int AS pending_total,
      COUNT(*) FILTER (
        WHERE status = 'PENDING_UPLOAD' AND "uploadExpiresAt" > NOW()
      )::int AS pending_active,
      COUNT(*) FILTER (
        WHERE status = 'PENDING_UPLOAD' AND "uploadExpiresAt" <= NOW()
      )::int AS pending_expired,
      COUNT(*) FILTER (
        WHERE status = 'PENDING_UPLOAD' AND "uploadExpiresAt" IS NULL
      )::int AS pending_missing_expiry,
      COUNT(*) FILTER (
        WHERE status = 'PENDING_UPLOAD' AND "uploadExpiresAt" <= NOW() - INTERVAL '1 hour'
      )::int AS expired_over_one_hour,
      COUNT(*) FILTER (WHERE status = 'VERIFYING')::int AS verifying_total,
      COUNT(*) FILTER (
        WHERE status = 'VERIFYING'
          AND "verificationStartedAt" <= NOW() - INTERVAL '10 minutes'
      )::int AS verifying_stale,
      COUNT(*) FILTER (
        WHERE status = 'PENDING_UPLOAD'
          AND "uploadExpiresAt" <= NOW()
          AND storage_layout = 'STAGED_IMMUTABLE_V1'
          AND has_staging_identity
      )::int AS expired_staged_cleanup_eligible
    FROM sessions
  `);
  const row = result.rows[0];
  console.log(`OWNER_SCOPE_STATUS=${Number(row.owners_with_sessions) > 0 ? "MATCHED" : "EMPTY"}`);
  console.log(`OWNERS_WITH_SESSIONS=${row.owners_with_sessions}`);
  console.log(`PENDING_TOTAL=${row.pending_total}`);
  console.log(`PENDING_ACTIVE=${row.pending_active}`);
  console.log(`PENDING_EXPIRED=${row.pending_expired}`);
  console.log(`PENDING_MISSING_EXPIRY=${row.pending_missing_expiry}`);
  console.log(`EXPIRED_OVER_ONE_HOUR=${row.expired_over_one_hour}`);
  console.log(`VERIFYING_TOTAL=${row.verifying_total}`);
  console.log(`VERIFYING_STALE=${row.verifying_stale}`);
  console.log(`EXPIRED_STAGED_CLEANUP_ELIGIBLE=${row.expired_staged_cleanup_eligible}`);
  await client.query("ROLLBACK");
} finally {
  await client.end();
}
