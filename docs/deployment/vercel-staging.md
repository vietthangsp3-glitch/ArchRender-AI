# Vercel staging runbook

Deploy only the Next.js application. The GPU worker, Docker V4 stack, Python
gateway, model weights, and database migrations are separate operator-managed
systems and are not part of a Vercel build.

## Project settings

- Root Directory: `apps/web`
- Framework Preset: Next.js
- Node.js: `24.x`
- Install Command: Automatic (uses the repository lockfile and pinned
  `packageManager`)
- Build Command: read from `apps/web/vercel.json`
- Output Directory: Automatic; do not override Next.js `.next` handling
- Production deployment: disabled/not invoked for this staging checkpoint

The build command generates Prisma Client and builds only `@archrender/web`. It
does not run `prisma migrate`, Docker, a GPU worker, Python, or model downloads.

Because the repository pins pnpm 11, set `ENABLE_EXPERIMENTAL_COREPACK=1` in the
Vercel build environment so Vercel honors the root `packageManager` field. Do
not replace the automatic install command with an unversioned `pnpm install`.

## Preview environment variables

Configure values in Vercel's Preview environment; never commit the values.

Required application variables:

- `DATABASE_URL` — pooled Neon runtime connection string; migrations use a
  separate operator workflow and never run in Vercel builds.
- `AUTH_CONTEXT_SECRET` — server-only authentication context secret, at least
  32 bytes.
- `AUTH_TRUSTED_ORIGINS` — comma-separated exact trusted staging origins.
- `AUTH_TRUST_PROXY` — enables trusted Vercel proxy headers.
- `R2_ACCOUNT_ID` — Cloudflare account identifier.
- `R2_BUCKET_NAME` — private staging/development bucket name.
- `R2_ACCESS_KEY_ID` — bucket-scoped server credential.
- `R2_SECRET_ACCESS_KEY` — bucket-scoped server credential.
- `ASSET_STORAGE_ENVIRONMENT` — storage environment guard for staging.

Optional application variables:

- `R2_ENDPOINT` — explicit HTTPS R2 endpoint; when omitted it is derived from
  `R2_ACCOUNT_ID`.
- `ASSET_MAX_UPLOAD_BYTES`
- `ASSET_MAX_IMAGE_DIMENSION`
- `ASSET_MAX_DECODED_PIXELS`
- `ASSET_SIGNED_URL_TTL_SECONDS`
- `ASSET_INITIATE_RATE_PER_MINUTE`
- `ASSET_MAX_CONCURRENT_UPLOADS`
- `ASSET_OWNER_QUOTA_BYTES`
- `ASSET_VERIFICATION_STALE_SECONDS`
- `ASSET_MAX_VERIFICATION_ATTEMPTS`
- `ASSET_MAX_CONCURRENT_VERIFICATIONS`

Build-only variable:

- `ENABLE_EXPERIMENTAL_COREPACK` — makes Vercel use the pinned pnpm version.

Do not configure `AI_ENGINE_GATEWAY_URL`, `AI_ENGINE_WORKER_TOKEN`, model paths,
or GPU provider credentials for the web project. Those belong to the private
worker environment.

## Protected staging procedure

1. Create/link a Vercel project without invoking a production deployment.
2. Configure the Preview variables above and verify `DATABASE_URL` uses Neon's
   pooled runtime endpoint.
3. Enable Vercel Authentication for **All Deployments** before sharing or
   testing any generated URL.
4. Deploy a non-production branch or run `vercel deploy` without `--prod`.
5. Verify login, CSRF/origin handling, Projects, Asset Library, R2 signed upload,
   and Render Job creation. The external AI worker remains disabled.
6. Do not promote, attach the primary domain, or change DNS at this checkpoint.
