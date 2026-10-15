# @archrender/database

Phase 2A persistence foundation for ArchRender AI. This package owns the Prisma
schema, generated PostgreSQL client, owner-scoped repositories, and transaction
boundary. Application routes must use `PersistenceService` rather than importing
Prisma delegates directly.

## Local setup

1. Copy `.env.example` to `.env` and replace the placeholder with a local or
   manually provisioned PostgreSQL connection string.
2. Run `pnpm db:generate` from the repository root.
3. Run `pnpm db:migrate` to apply migrations to a development database.

Production credentials and production migration execution are intentionally not
managed by this repository.

## PostgreSQL integration acceptance

With a development-only `DATABASE_URL` present in the local `.env`, run:

```bash
pnpm --filter @archrender/database test:integration
```

The suite verifies the applied migration, CRUD, foreign keys, rollback,
idempotency, and two-owner isolation. Records use an `m2a-<timestamp>-<uuid>`
identifier and are deleted by their captured owner UUIDs in `afterAll`. It never
resets the database or performs broad cleanup queries.
