import "dotenv/config";

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[immutable-storage-audit] DATABASE_URL_MISSING");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();

  const migration = await client.query(
      `SELECT count(*)::int AS count
       FROM "_prisma_migrations"
       WHERE migration_name = $1
         AND finished_at IS NOT NULL
         AND rolled_back_at IS NULL`,
      ["20261015000100_phase_2d_d_immutable_asset_storage"],
    );
  const statuses = await client.query(
      `SELECT "status"::text AS status, count(*)::int AS count
       FROM "Asset"
       GROUP BY "status"
       ORDER BY "status"::text`,
    );
  const assets = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE "status" = 'READY')::int AS ready,
              count(*) FILTER (WHERE "status" = 'DELETED')::int AS deleted
       FROM "Asset"`,
    );
  const violations = await client.query(
      `SELECT
         count(*) FILTER (
           WHERE "checksumSha256" IS NOT NULL
             AND "checksumSha256" !~ '^[0-9a-f]{64}$'
         )::int AS invalid_checksum,
         count(*) FILTER (WHERE "byteSize" IS NOT NULL AND "byteSize" <= 0)::int AS invalid_byte_size,
         count(*) FILTER (
           WHERE ("width" IS NOT NULL AND "width" <= 0)
              OR ("height" IS NOT NULL AND "height" <= 0)
         )::int AS invalid_dimensions
       FROM "Asset"`,
    );
  const schemaState = await client.query(
      `SELECT
         to_regclass('public."AssetStorageObject"') IS NOT NULL AS storage_table_exists,
         ARRAY(
           SELECT enumlabel::text
           FROM pg_enum
           JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
           WHERE pg_type.typname = 'AssetStatus'
           ORDER BY enumsortorder
         ) AS asset_status_values`,
    );
  const integrationCleanup = await client.query(
    `SELECT count(*)::int AS remaining_test_owners
     FROM "User"
     WHERE "email" ~ '^(m2a|m2b|m2c|m2db)-.*@integration\\.invalid$'`,
  );

  const result = {
    migrationAppliedCount: migration.rows[0]?.count ?? 0,
    storageTableExists: schemaState.rows[0]?.storage_table_exists ?? false,
    assetStatusValues: schemaState.rows[0]?.asset_status_values ?? [],
    assets: assets.rows[0] ?? { total: 0, ready: 0, deleted: 0 },
    statusCounts: statuses.rows,
    preflightViolations: violations.rows[0] ?? {},
    integrationCleanup: integrationCleanup.rows[0] ?? { remaining_test_owners: 0 },
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
  console.error(`[immutable-storage-audit] READ_ONLY_QUERY_FAILED code=${code}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
