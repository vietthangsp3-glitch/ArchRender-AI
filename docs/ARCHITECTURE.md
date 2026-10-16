# ArchRender AI — Kiến trúc hiện tại

> Ghi chú 2026-10-16: tài liệu lịch sử bên dưới mô tả tiến trình từ Phase 2D-C. Trạng thái thực tế mới nhất nằm tại [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Render Jobs, private AI gateway và GPU worker đã có mã nguồn; GPU execution thật vẫn chưa được kiểm chứng.

## Phạm vi

Project Management đã dùng dữ liệu PostgreSQL thật. Các màn hình job/GPU/cost và
render result vẫn là dữ liệu demo có nhãn rõ ràng. Asset Library đã dùng private
R2; Redis, GPU provider và ComfyUI vẫn chưa được gọi. Mọi trạng thái job/GPU/chi phí trên UI
đều có nhãn **Demo**.

## Cấu trúc repository

```text
apps/
  web/                 Next.js App Router, routes và UI tương tác
packages/
  assets/              Asset domain/service, validation và private R2 adapter
  config/              hằng số dùng chung, giới hạn upload
  database/            Prisma schema, migration, client và persistence boundary
  projects/            Project validation, application service và domain DTO
  schemas/             Zod schemas cho typed boundary tương lai
  ui/                  utility UI dùng chung
arch-ai-cloud-v3/      AI Engine hiện hữu, chỉ đọc trong Phase 1
docs/
  ARCHITECTURE.md
  AI_ENGINE_AUDIT.md
```

Các package dự kiến tiếp theo (`gpu-providers`, `workflow-engine`, `worker`) chưa
được tạo. `database` chỉ chứa abstraction có consumer rõ ở các
milestone backend tiếp theo.

## Ranh giới ứng dụng

- `apps/web/app`: routing và metadata.
- `apps/web/components`: app shell, UI primitives và feature screens.
- `packages/schemas`: validation contracts độc lập với transport.
- `packages/config`: policy không chứa secret.
- `packages/database`: schema/migration và data access owner-scoped; API tương lai
  không được gọi Prisma delegate trực tiếp.
- `packages/projects`: Project lifecycle, validation, authorization orchestration,
  idempotency và optimistic concurrency; không chứa UI hoặc browser code.
- `packages/assets`: Asset upload intent, lifecycle, inspection và R2 abstraction;
  không chứa route handler, UI hoặc cloud credential thật.
- `arch-ai-cloud-v3`: source AI Engine legacy cần được bọc bởi private engine gateway ở Phase 3.

## Data foundation Phase 2A

- Prisma ORM 7 stable với PostgreSQL driver adapter; Prisma 8 RC không được dùng.
- UUID primary key, timestamp, foreign key, unique constraint và index được khai
  báo ở schema và migration đầu tiên.
- Render job lưu input/output bằng bảng nối có role và position để bảo toàn lineage.
- Workflow version là immutable record; preset giữ `currentVersionNumber` để việc
  tạo version sau này diễn ra trong transaction.
- GPU allocation và provider usage mới chỉ là persistence preparation, không có
  provider call.
- Session chỉ lưu `tokenHash`; không có plain session token trong database model.
- `Project`, `Asset`, `RenderJob` và `WorkflowPreset` có composite unique
  `(id, ownerId)`. Repository bắt buộc nhận `ownerId` khi lookup/update record.
- `PersistenceService.transaction` là transaction boundary cho service layer.

Migration production không tự chạy. Người vận hành phải tự cung cấp
`DATABASE_URL`, review migration SQL và chạy `pnpm db:migrate:deploy` trong môi
trường đã được phê duyệt.

## Authentication & authorization Phase 2B

- Không có public registration hoặc tài khoản mặc định.
- OWNER đầu tiên được tạo bằng CLI tương tác; unique singleton key ngăn bootstrap
  lần hai kể cả khi hai tiến trình chạy cạnh tranh.
- Argon2id dùng memory cost 19 MiB, time cost 2 và parallelism 1.
- Browser giữ opaque token 256-bit trong cookie HttpOnly/SameSite=Lax; database chỉ
  lưu SHA-256 token hash.
- Session có absolute TTL 12 giờ, idle timeout 30 phút, rotation 15 phút, touch 5
  phút và tối đa 5 session hoạt động.
- Login attempt được lưu PostgreSQL theo HMAC của account identifier và IP để rate
  limit hoạt động trên nhiều application instance mà không lưu email/IP thô.
- Proxy chỉ redirect sớm theo cookie presence. Mỗi private page và API vẫn xác minh
  session server-side; authorization policy nằm trong `packages/auth`.
- Mutation auth endpoints kiểm tra Origin/Host. Forwarded headers chỉ được tin khi
  `AUTH_TRUST_PROXY=true` và proxy phía trước được người vận hành kiểm soát.
- Login, logout và bootstrap thành công ghi activity log; failed/blocked login ghi
  vào `LoginAttempt` bằng hashed identifiers.

## Checklist Phase 2B

- [x] Argon2id login với generic errors
- [x] Opaque database session, expiry, idle timeout, rotation và revocation
- [x] PostgreSQL-backed brute-force cooldown theo account/IP
- [x] Manual OWNER bootstrap, không public registration
- [x] Proxy guard và server-side route guard
- [x] CSRF/origin validation và explicit proxy trust
- [x] Central owner/RBAC policy foundation
- [x] Unit, component và PostgreSQL integration tests
- [x] OWNER thật được người vận hành bootstrap và login local được xác minh

## Project Management Phase 2C

Luồng phụ thuộc được giữ rõ ràng:

```text
React UI
  -> Next.js Route Handler / Server Component
  -> ProjectService
  -> role + authenticated principal
  -> ProjectRepository
  -> Prisma / PostgreSQL
```

- Tất cả Project reads/mutations dùng `principal.id`; API không nhận `ownerId`.
- Detail lookup dùng composite `(id, ownerId)`, vì vậy UUID của owner khác trả về
  not-found thay vì tiết lộ sự tồn tại của record.
- List query giới hạn search, status, sort, direction, page và page size; filtering,
  ordering và pagination đều chạy trong PostgreSQL.
- Create nhận UUID request riêng, tạo deterministic slug suffix và dựa trên unique
  `(ownerId, slug)` để retry cùng request không tạo bản ghi thứ hai.
- Edit/archive/restore yêu cầu `expectedUpdatedAt`. Conditional `updateMany` trả về
  conflict khi record đã thay đổi, tránh ghi đè im lặng.
- Project `ARCHIVED` là read-only. Restore đưa project về `ACTIVE`. Archive không
  xóa asset/render job; permanent delete không có trong UI hoặc API Phase 2C.
- Mutation kiểm tra session và Origin/Host. Expected validation/not-found/conflict
  được trả thành mã an toàn; stack trace và database details không trả cho client.
- Create/update/archive/restore ghi ActivityLog trong cùng transaction với mutation.
- Dashboard dùng project count thật. Image/Video Studio chỉ dùng project selector
  thật làm ngữ cảnh; không tạo render job hoặc gọi GPU.

Không có migration Phase 2C: schema và index Phase 2A đã đủ cho phạm vi này.
Asset Storage, binary lifecycle, render execution và dependency cleanup của
permanent delete thuộc milestone sau.

### Checklist Phase 2C

- [x] Create/list/detail/edit Project trên PostgreSQL
- [x] Search/filter/sort và database pagination
- [x] Archive/restore, không permanent delete
- [x] Server-side validation, session guard, CSRF và owner isolation
- [x] Idempotent create và optimistic concurrency
- [x] Empty/loading/error/confirmation states theo Premium Dark Studio
- [x] Unit và PostgreSQL integration tests
- [x] Dashboard count và Studio selectors dùng project data thật
- [ ] Asset Storage, render execution và GPU provisioning — ngoài Phase 2C

## Storage Foundation Phase 2D-A

Asset Service dùng authenticated principal và owner-scoped repository; client
không được gửi owner, bucket hoặc object key. `StorageProvider` che giấu AWS SDK
và R2 adapter chỉ chạy server-side với private bucket, bounded retry/timeout và
presigned URL TTL ngắn. Validation kiểm tra extension, MIME, magic bytes, decoded
format, dimension và pixel count trước khi asset được phép `READY`.

Migration `20261014000300_phase_2d_a_storage_foundation` đã được operator áp dụng
trên PostgreSQL development. Upload API, completion verifier và cleanup CLI đã được
triển khai trong 2D-B; real R2 development acceptance đã PASS. Chi tiết tại
[Storage Foundation](STORAGE_FOUNDATION.md).

## Secure Upload API Phase 2D-B

Next.js cung cấp API initiate upload, complete verification và owner-authorized
signed read URL. Mutations dùng session + Origin guard; payload JSON được đọc có
giới hạn. Reservation quota chạy trong transaction có owner advisory lock.

Completion dùng conditional state claim để chỉ một verifier xử lý binary. Invalid
object chuyển `REJECTED`; transient storage failure quay lại trạng thái recoverable.
Maintenance là CLI one-shot cho scheduler, có reference/key guard và idempotent
cleanup. Real R2 development acceptance đã PASS; real browser 2D-C vẫn là operator checkpoint. Chi tiết tại
[Secure Upload API](SECURE_UPLOAD_API.md).

## Asset Library UI Phase 2D-C

```text
React Client
  -> typed Asset client
  -> Next.js Route Handler (session, Origin, bounded validation)
  -> AssetService
  -> AssetRepository / ProjectRepository
  -> PostgreSQL + StorageProvider / private R2
```

- `GET /api/assets` dùng filter/sort/page allowlist và database pagination; response
  không chứa bucket, object key hoặc internal metadata.
- Detail/delete lookup luôn owner-scoped. Delete ghi tombstone `DELETED` và
  ActivityLog; referenced asset hoặc asset thuộc Project archived bị chặn.
- Binary không đi qua Next.js. Browser PUT trực tiếp bằng signed headers, rồi gọi
  completion để server xác minh trước `READY`.
- Preview component chỉ xin signed GET khi card đi gần viewport, hủy stale request,
  không persist URL và không dùng shared/public cache.
- Image Studio chỉ query `READY` theo Project + AssetType; đổi Project reset mọi
  selection. Các controls render vẫn là Demo và không tạo RenderJob.
- Schema hiện tại đã có `DELETED`, `deletedAt` và lineage relations nên 2D-C không
  cần migration. Chi tiết vận hành tại [Asset Library guide](ASSET_LIBRARY.md).

## Kiến trúc mục tiêu sau Phase 1

```text
Browser
  -> Next.js Web (auth, validation, signed upload)
  -> PostgreSQL (project/job metadata)
  -> S3-compatible storage (binary assets)
  -> Redis/BullMQ (job commands)
  -> Worker (idempotency, retries, cost guard)
  -> GPU Provider Adapter (Vast.ai / RunPod)
  -> Private AI Engine Gateway
  -> ComfyUI (never public)
```

`GPU allocation status` và `AI engine readiness` là hai state machine khác nhau. Worker chỉ queue prompt khi container, ComfyUI, model manifest và workflow version đều đã sẵn sàng.

## Dependency hiện tại

- Next.js 16 App Router, React 19, TypeScript strict.
- Tailwind CSS 4 cho design tokens và responsive layout.
- Lucide React cho icon nhất quán.
- Motion chỉ dùng cho chuyển động cần thiết và tôn trọng `prefers-reduced-motion`.
- React Hook Form + Zod đã sẵn sàng cho form boundary; Zod schemas nằm ở package dùng chung.
- Vitest + Testing Library cho unit/component tests.
- Prisma 7.10, PostgreSQL adapter và `pg` cho server-side persistence.

## Quy tắc bảo mật đã đặt nền

- Không có secret/client API key trong source.
- Upload UI lấy MIME/size policy từ backend (development mặc định 25 MiB); completion luôn xác minh lại magic bytes, kích thước, ownership và object identity do server sinh.
- ComfyUI không có URL trong client.
- Các thao tác GPU chỉ mô phỏng và yêu cầu confirm.
- Production sẽ dùng signed URL thời hạn ngắn, authorization ở data access layer và audit log cho thao tác nhạy cảm.

## Checklist Phase 1

- [x] pnpm monorepo và strict TypeScript
- [x] design tokens, sidebar, header, mobile drawer
- [x] 9 trang chính và navigation
- [x] upload/preview local có kiểm tra MIME/kích thước
- [x] before/after slider
- [x] preset/settings/advanced panel
- [x] render và job progress ghi nhãn Demo
- [x] GPU state tách biệt engine readiness
- [x] Docker V3 audit và kế hoạch V4
- [x] lint, typecheck, test, build scripts
- [ ] Kết nối backend/GPU — ngoài Phase 1

## Checklist Phase 2A

- [x] PostgreSQL schema cho các entity cốt lõi
- [x] enum, ownership key, foreign key, unique constraint và query index
- [x] migration SQL có thể review trước khi áp dụng
- [x] Prisma client lifecycle và PostgreSQL driver adapter
- [x] owner-scoped repository và transaction boundary
- [x] unit test cho owner scope/idempotency scope
- [x] Migration được người dùng áp dụng và nghiệm thu trên PostgreSQL development
- [x] Integration test CRUD, FK, transaction rollback, idempotency và owner isolation
- [ ] Auth, CRUD/API, storage và job execution — milestone sau

## Rủi ro cần GPU thật

- Driver/CUDA/PyTorch/ComfyUI compatibility trên image provider thực tế.
- VRAM peak và latency của ControlNet Canny + Depth + Normal.
- Quy ước depth và normal map từ từng phần mềm 3D.
- Chất lượng tiled diffusion upscale 4K và seam artifact.
- Wan 2.2 I2V model set, node schema, VRAM và thời gian tạo clip.
- Cold start, model caching, preemption/recovery và đo actual cost.
