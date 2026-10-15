# Storage Security Hardening — 2D-D1 Decision Record

Status: **2D-D2/D3/D4 implemented locally; migration applied; final cloud re-acceptance pending**  
Date: 2026-10-15  
Scope: Asset storage only. The development migration is applied. No production deployment,
global cleanup, credential change, Docker/GPU/RenderJob, or 2E work is part of this checkpoint.

## 2D-D2 implementation checkpoint

Implemented in source and fake-storage contract tests:

- distinct server-generated STAGING and ORIGINAL identities;
- browser presigning restricted to STAGING;
- staging HEAD followed by conditional GET using the exact HTTP ETag;
- SHA-256 calculated from the bytes actually read and decoded;
- final PutObject with `If-None-Match: *` and Content-MD5;
- bounded final read-back verification before READY;
- durable final key reservation and recovery when storage succeeded before DB commit;
- single-winner VERIFYING claim plus create-once conflict verification;
- maximum verification attempts and a per-process verification memory/CPU gate;
- legacy READY resolution through `LEGACY_GUARDED` without moving its object;
- schema and review-only migration `20261015000100_phase_2d_d_immutable_asset_storage`.

Cleanup/recovery/quota maintenance and private GRID/DETAIL derivatives are now implemented.
Maintenance remains dry-run by default and uses database-held exact object identities;
real execution still requires an explicit environment confirmation. Legacy objects stay
guarded in place and are not migrated automatically.

## Decision summary

New uploads should use a two-identity lifecycle:

```text
browser
  -> presigned PUT to a random staging key
  -> server conditional GET of the staging snapshot
  -> bounded decode + SHA-256 + metadata verification
  -> server PutObject of those exact verified bytes to a different random final key
     with If-None-Match: *
  -> verify final metadata
  -> commit READY + immutable identity in PostgreSQL
  -> generate private derivatives from the verified final object
  -> delete staging only after its upload contract has expired
```

The browser never receives a PUT contract for the final key. Signed GET and future
RenderJob inputs resolve only the verified final object. An old staging contract may
still recreate or overwrite the staging object until expiry, but it cannot mutate the
final object.

Server-side `CopyObject` is **not selected** for finalization. Cloudflare documents
that source and destination conditions on CopyObject are not atomic relative to each
other, and the destination condition extension is currently beta. The server instead
reads a conditionally selected staging snapshot into a bounded buffer and writes the
same bytes to the final key using atomic create-once PutObject.

## Evidence from Cloudflare R2

- R2 evaluates `PutObject` conditions atomically with the committed bucket state.
  Concurrent `If-None-Match: *` writes to an absent key allow at most one winner.
- `GetObject` supports `If-Match`, allowing finalization to fail closed if the staging
  identity observed by completion is no longer current when the body is selected.
- R2 is strongly consistent for object writes, reads, deletes, and listings through
  the S3/Workers APIs.
- Conditional destination headers for CopyObject are beta. Cloudflare explicitly
  states that selection of the conditional source and commit of the conditional
  destination are not atomic relative to one another.
- S3 PutObject supports `Content-MD5`, but the compatibility table does not promise
  the AWS flexible SHA-256 checksum headers for PutObject. Application SHA-256 remains
  authoritative; ETag is only a storage identity/concurrency token.
- R2 bucket versioning and S3 Object Lock are not implemented in the compatibility
  table. The proposed guarantee is application-level create-once, not regulatory WORM.

Primary references:

- <https://developers.cloudflare.com/r2/reference/consistency/>
- <https://developers.cloudflare.com/r2/api/s3/api/>
- <https://developers.cloudflare.com/r2/api/s3/extensions/>
- <https://developers.cloudflare.com/r2/objects/upload-objects/>

These capabilities still require a small, separately approved development-bucket
contract test before relying on them against real R2.

### R2 finalization diagnostic (2026-10-15)

A separately approved sequential probe reached `final_put` and received provider HTTP 400,
which the application safely mapped to `StorageError.UNAVAILABLE` / HTTP 503. Offline AWS
SDK serialization then confirmed that SDK v3 was adding optional CRC32 full-object headers
to the otherwise valid conditional PutObject. R2 documents `Content-MD5` support but does
not support CRC32 FULL_OBJECT for this operation. The R2 client now uses
`requestChecksumCalculation: WHEN_REQUIRED`, retaining the explicit `Content-MD5`,
`Content-Length`, `Content-Type`, metadata, and `If-None-Match: *`. A transport-level
regression test asserts the serialized headers. No cloud rerun was performed by this fix;
the final real R2 acceptance remains an operator-approved checkpoint.

## Source audit

### Existing controls that should be retained

- Object keys contain environment, owner, project, asset, and 128 bits of randomness.
- Upload initiation is serialized per owner with a PostgreSQL advisory transaction lock.
- Upload request IDs are owner-scoped and idempotent.
- PUT contracts bind content type, content length, asset metadata, and a short TTL.
- Completion uses a single `PENDING_UPLOAD -> VERIFYING` claim and bounded reads.
- Sharp validates magic bytes, decoded format, dimensions, and decoded pixel count.
- SHA-256, actual size, MIME, dimensions, ETag metadata, and audit events are stored.
- Reads are owner-scoped, READY-only, private/no-store, and HEAD-check the stored ETag.
- Deletion checks RenderJob input/output references and uses deferred object cleanup.
- Quota reservation, initiation rate, and concurrent upload limits are owner-scoped.
- Asset Library previews are lazy, abort stale requests, and limit URL refresh attempts.
- Image Studio requests only project-scoped READY assets.

### P0 findings

1. **The upload key is also the READY read key.** An unexpired old presigned PUT can
   overwrite a verified object. A HEAD before issuing a signed GET detects many changes,
   but cannot protect a signed URL already issued and has a HEAD/GET TOCTOU window.
2. **There is no server-controlled final identity.** `StorageProvider` has no
   conditional read/create-once operation and the database has no staging/final split.
3. **READY does not encode integrity strength.** Existing READY records and future
   immutable READY records cannot be distinguished safely by Image Studio or RenderJob.
4. **Crash after storage write but before READY is ambiguous.** There is no durable
   final object record from which a retry can prove and finish the transaction.

### P1 findings

1. `cleanup` is destructive by default. It has no dry-run default, explicit environment
   argument, execution identifier, per-record structured result, or retry backoff.
2. Cleanup knows only one key. It cannot reconcile staging, final, derivative, or orphan
   final objects independently after partial failure.
3. Stale VERIFYING records can be reclaimed without a maximum-attempt ceiling, allowing
   repeated verification/finalization work indefinitely.
4. Quota reservation is transactionally serialized for initiation, but there is no
   first-class accounting of multiple physical objects during staging/final overlap or
   thumbnails. Logical quota and billable physical bytes would diverge.
5. Preview cards download originals. Lazy loading and pagination limit fan-out, but a
   grid can still transfer several verified 4K images.
6. Storage ETag is kept in JSON metadata instead of a typed, indexed object identity.
7. The current key validator understands only the legacy single-object layout.

### P2 findings

1. The service reads a complete upload into memory. This is bounded at 25 MiB and safe
   for the current policy, but finalization and thumbnail concurrency must also be bounded.
2. Maintenance catches individual errors but records only aggregate counts, limiting
   diagnosis and safe targeted retries.
3. There is no durable derivative provenance tying a thumbnail checksum to its verified
   source object.

## Selected architecture

### Storage identities

Use a new `AssetStorageObject` record rather than adding a growing set of staging and
thumbnail columns to `Asset`. One Asset can then own these bounded roles:

- `STAGING`: browser-writable only during the upload contract.
- `ORIGINAL`: server-written, create-once, authoritative render input.
- `THUMBNAIL_GRID`: private derivative, recommended maximum 640 px.
- `THUMBNAIL_DETAIL`: private derivative, recommended maximum 1600 px.

Each record contains the bucket, random server-generated key, role, state, content type,
byte size, dimensions, SHA-256, storage ETag, source object ID where applicable, expiry /
cleanup timestamps, retry counters, and redacted failure code. The relation must include
`assetId + ownerId`; project identity remains authoritative on the parent Asset.

`Asset` gains:

- `storageLayout`: `LEGACY_SINGLE_OBJECT` or `STAGED_IMMUTABLE_V1`.
- `integrityStatus`: `PENDING`, `VERIFIED_IMMUTABLE`, `LEGACY_GUARDED`, or `FAILED`.
- `finalizedAt`.

The existing `bucket` and `objectKey` columns remain unchanged during the first migration
for backward compatibility. New code resolves new layouts from `AssetStorageObject` and
legacy layouts from the existing columns. Dropping legacy columns is explicitly outside
2D-D.

### Key layout

Keys remain generated and validated server-side:

```text
<env>/owners/<owner>/projects/<project>/assets/<asset>/staging/<random32>
<env>/owners/<owner>/projects/<project>/assets/<asset>/original/<random32>
<env>/owners/<owner>/projects/<project>/assets/<asset>/derivatives/grid/<random32>
<env>/owners/<owner>/projects/<project>/assets/<asset>/derivatives/detail/<random32>
```

The final key is allocated during initiation but is never returned to the browser.

### Finalization protocol

1. In one database transaction, lock the Asset and claim `PENDING_UPLOAD -> VERIFYING`.
2. Load the exact owner/project/asset-linked STAGING and ORIGINAL records.
3. Conditional GET staging with the completion-observed ETag (`If-Match`). Read at most
   configured maximum + 1 byte.
4. Validate signed metadata, length, actual MIME, magic bytes, dimensions, decoded pixels,
   and optional client checksum. Compute authoritative SHA-256 and Content-MD5.
5. Generate orientation-normalized thumbnail bytes from the verified buffer with Sharp.
   Strip metadata by default; enforce output pixel and byte limits.
6. Put the exact verified original buffer to the final key with `If-None-Match: *`,
   Content-MD5, content type, and server metadata containing asset identity and SHA-256.
7. On `412 PreconditionFailed`, treat the operation as recovery, not success: read the
   existing final object conditionally/bounded and require exact checksum, size, MIME,
   and identity metadata match. Otherwise mark integrity failure and stop.
8. Put derivatives with the same create-once rule. Thumbnail failure does not delete or
   invalidate the original; it remains retryable and the UI falls back safely.
9. HEAD final, compare the committed metadata, then transactionally write checksums /
   ETags, set `VERIFIED_IMMUTABLE`, set `finalizedAt`, and transition to READY.
10. Retain the staging identity until `uploadExpiresAt + grace`. Cleanup then deletes it
    exactly, preventing a late replay from recreating an untracked staging object.

The current single-winner VERIFYING claim prevents ordinary concurrent finalizers. The
conditional final PUT and recovery verification protect crash/retry and split-brain cases.

### Read protocol

- New assets: require `READY + VERIFIED_IMMUTABLE` and sign only ORIGINAL or a verified
  derivative. Never sign STAGING.
- Image Studio: list/select only `READY + VERIFIED_IMMUTABLE`, except legacy behavior
  explicitly allowed during the compatibility window.
- Existing assets: retain current ETag guard and label internally as `LEGACY_GUARDED`.
  Do not claim they are immutable.
- Integrity mismatch: fail closed with the existing safe client error; do not expose key,
  ETag, provider response, or checksum.

## Existing READY asset compatibility

The migration performs no R2 operation and does not rewrite any key.

1. Existing records become `LEGACY_SINGLE_OBJECT`.
2. Existing READY rows become `LEGACY_GUARDED`; their current objectKey remains readable
   through the existing ETag + checksum guard.
3. A later one-shot, default-dry-run migration command can migrate one exact asset at a
   time: conditional read legacy object, verify stored checksum and image metadata, create
   a new ORIGINAL with `If-None-Match: *`, verify, then atomically switch database layout.
4. The legacy object remains until the new final object is committed and a separate,
   approved cleanup pass confirms no references need the old identity.
5. No bulk scan, broad prefix delete, or automatic migration is permitted.

## Migration plan — created, not applied

Proposed migration name:

```text
20261015000100_phase_2d_d_immutable_asset_storage
```

The migration should:

1. Add `AssetStorageLayout`, `AssetIntegrityStatus`, `AssetStorageObjectRole`, and
   `AssetStorageObjectState` enums.
2. Add nullable/backward-compatible `storageLayout`, `integrityStatus`, and `finalizedAt`
   to Asset, backfill explicitly by current status, then make required with defaults safe
   for legacy rows.
3. Create `AssetStorageObject` with composite owner linkage, unique bucket/object key,
   unique Asset/role, cleanup indexes, and bounded retry fields.
4. Add check constraints in reviewed SQL for 64-character lowercase SHA-256 and positive
   sizes/dimensions where present.
5. Add no rows for existing assets and perform no cloud operation.

The reviewed migration uses `PENDING` as the database default. This is deliberately
fail-closed: an older application binary can still create a pending legacy-layout row, but
it cannot transition that row to READY without the new verification transaction. Deployers
must therefore quiesce upload completion while the migration and compatible application
version are switched.

### Metadata deletion and lineage policy

- `AssetStorageObject -> Asset` is `ON DELETE RESTRICT`. Ordinary asset deletion is a
  logical tombstone; it never cascades away the only record of an R2 object.
- `sourceObjectId` is also `ON DELETE RESTRICT`. A composite foreign key includes
  `(sourceObjectId, assetId, ownerId)`, so a derivative cannot name a source belonging to
  another asset or owner and the lineage cannot silently become null.
- Cleanup first deletes the exact R2 key after all guards succeed, then marks the storage
  row `DELETED` with `deletedAt`. Storage metadata remains a durable tombstone.
- Physical metadata purge is a separate retention operation. It may delete derivative
  tombstones before their source, and storage tombstones before the parent Asset, only
  after reconciliation proves that no object or reference remains. No regular API path
  performs this purge.
- `unique(assetId, role)` is intentional for D2: one STAGING and one ORIGINAL reservation
  are reused by retries and concurrent completion. A fresh upload attempt uses a fresh
  Asset. Supporting multiple derivative generations per role requires a later versioned
  identity model, not weakening this uniqueness constraint.

### Migration locking and rollback

The migration is one PostgreSQL transaction with a 5-second lock timeout and 5-minute
statement timeout. Adding enum types and the empty storage table is bounded; the explicit
Asset backfill and constraint validation scan existing Asset rows and can hold row/table
locks, so application upload writes should be quiesced and the operator should inspect
table size and active transactions before approval. A timeout rolls the whole migration
back. There is no automatic down migration: before application, remove/edit only this
unapplied directory; after application, keep additive schema until all staged-layout data
has an approved reverse migration.

Rollback before application: remove the new migration directory. Rollback after application:
an old application may be used only for read-only recovery while upload completion is paused;
do not drop the new table until all new-layout uploads are absent or separately migrated.
Destructive SQL rollback is not automated.

This is a major architecture/schema change. The migration SQL has been created for review;
execution is stopped before Neon deploy as required.

## Cleanup and recovery design

The one-shot CLI must change to:

- default `--dry-run`; require `--execute` for mutation;
- require explicit `--environment development|staging|production` matching loaded config;
- reject production execution unless a separate explicit confirmation mechanism is added;
- accept bounded `--limit` and optional exact `--asset-id`;
- query due database records, never discover deletion targets from a broad R2 listing;
- verify bucket, complete key grammar, object role, owner, project, asset, and metadata;
- re-check RenderJob references immediately before original deletion;
- delete one exact key at a time; treat not-found as idempotent success;
- record attempts, exponential backoff with cap, next-attempt time, and safe error code;
- emit structured redacted summaries with an execution ID;
- retain staging cleanup eligibility until the presigned contract is certainly expired;
- reconcile final-written/database-not-READY by exact object record and checksum;
- never promote an unknown orphan to READY; quarantine/report it for exact-ID handling.

No scheduler or cleanup execution is approved in 2D-D1.

## Quota and resource policy

- Keep the current owner advisory lock, initiation rate, concurrent upload count, maximum
  upload bytes, dimension limit, and decoded pixel limit.
- Add a maximum verification/finalization-attempt setting and fail to a recoverable
  quarantine state after the bound.
- Count logical owner quota once per Asset using the declared/verified original size.
- Track physical bytes separately for staging/final/derivatives so overlap and cleanup debt
  are observable without double-charging the logical customer quota.
- PENDING and VERIFYING reserve declared bytes. REJECTED/DELETED release logical quota;
  their remaining physical bytes stay in cleanup debt until deletion succeeds.
- Finalization and thumbnail generation need process-level concurrency limits in addition
  to per-owner upload limits.

## Thumbnail policy

- GRID: fit inside 640 x 640, no enlargement, orientation normalized, WebP, quality 78.
- DETAIL: fit inside 1600 x 1600, no enlargement, orientation normalized, WebP, quality 82.
- Strip EXIF/ICC/XMP unless a documented color-profile requirement is approved.
- Derive only from a VERIFIED_IMMUTABLE original, with source object ID and source SHA-256.
- Store privately under a derivative role and issue short-lived owner-authorized GET URLs.
- Create with `If-None-Match: *`; verify derivative size, dimensions, MIME, and SHA-256.
- A derivative error is retryable and never modifies/deletes the original.
- Do not route arbitrary signed URLs through Next Image Optimization.

## Test plan after approval

Automated tests must cover the requirements in the milestone prompt, with special focus on:

- conditional staging GET and final create-once conflict mapping;
- concurrent and crash-recovered finalize;
- old staging replay leaving final checksum invariant;
- legacy READY reads without an immutable claim;
- default cleanup dry-run and exact-key execution;
- logical versus physical quota release;
- derivative provenance and bounded Sharp processing;
- READY/Image Studio exclusion for failed or pending integrity;
- redaction of URLs, keys, tokens, cookies, provider messages, and connection strings.

PostgreSQL integration tests run against the operator-applied development migration and use
dedicated exact-ID fixtures with bounded cleanup.

## Proposed real R2 acceptance budget

The immutable harness defaults to PLAN mode. Its status-only preflight has run without an
R2 request or database write. A separate `--execute` approval is required. The execution
uses two dedicated test owners, one project, four Assets, and at most six created objects:
concurrent STAGING/ORIGINAL, recovery STAGING/ORIGINAL, invalid-image STAGING, and one
controlled LEGACY object. The invalid-image ORIGINAL key is reserved but should remain
absent, so cleanup still issues one idempotent exact-key delete for it.

| Operation | Expected attempts | Purpose |
|---|---:|---|
| PUT | <= 9 | three staging uploads, create-once finals, replay, overwrite rejection, legacy fixture |
| GET | <= 18 | conditional staging/final reads, signed reads, and checksum-guarded cleanup |
| HEAD | <= 27 | final identity/read authorization and exact cleanup pre/post checks |
| COPY | 0 | CopyObject is intentionally not part of finalization |
| DELETE | <= 7 | six existing objects plus one idempotent absent reserved-final delete |
| OPTIONS | 1 | CORS preflight for the staging PUT contract |

The final test script must print only operation names, counts, safe error codes, and exact
test IDs—not signed URLs, storage keys, credentials, cookies, or connection strings.

Normal and failure cleanup is driven only by a run-scoped manifest. It verifies dedicated
test owner/project/asset membership, exact role-aware key grammar, and SHA-256 of every
existing object before deletion. The manifest contains no credentials, cookies, or signed
URLs and is retained after an interrupted/failed cleanup for explicit `--recover`; normal
successful cleanup removes it. Global listing or prefix deletion is never used.

## Approval checkpoint

The migration and local 2D-D2/D3/D4 implementation are complete. The next authorization
required is one bounded real R2 acceptance rerun that validates the corrected final PUT,
then sequential/concurrent recovery, private derivatives, and exact cleanup. Current work
does **not** authorize that rerun, destructive maintenance, Cloudflare configuration changes,
production deployment, or Milestone 2E.
