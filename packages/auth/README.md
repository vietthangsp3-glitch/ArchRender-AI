# @archrender/auth

Server-only authentication and authorization core for ArchRender AI.

- Argon2id password hashing.
- Opaque CSPRNG session tokens; PostgreSQL stores SHA-256 token hashes only.
- Absolute expiry, idle timeout, rotation, revocation, and active-session limit.
- PostgreSQL-backed account and IP cooldown tracking.
- Central role and owner-scope authorization helpers.
- Manual, interactive OWNER bootstrap with hidden password input.

## Manual OWNER bootstrap

First apply all migrations and configure `packages/database/.env`. Then run from
an interactive terminal:

```bash
pnpm auth:bootstrap-owner
```

The command asks for email, optional display name, password, and confirmation. It
does not accept the password through command-line arguments and does not print it.
It exits without changes when the primary OWNER already exists.

## Web runtime environment

Copy `apps/web/.env.example` to `apps/web/.env.local` and replace placeholders
locally. `AUTH_CONTEXT_SECRET` must be a cryptographically random value of at
least 32 bytes. Do not send its value through chat or commit it.

Set `AUTH_TRUST_PROXY=true` only when the application is behind a known proxy that
overwrites `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. Otherwise
forwarded headers are ignored. List exact allowed origins in
`AUTH_TRUSTED_ORIGINS`.
