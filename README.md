# ArchRender AI

Premium AI architectural visualization workspace. Repository hiện chứa nền tảng UI, Authentication/OWNER RBAC, Projects, private immutable R2 assets, Render Jobs/Job History, PostgreSQL worker queue, AI worker orchestration và Docker V4 private ComfyUI gateway. Docker V3 vẫn được giữ làm tài liệu legacy; GPU execution thật chưa được xác minh.

## Yêu cầu

- Node.js 24+
- pnpm 11+
- PostgreSQL 15+ chỉ khi muốn tự áp dụng migration Phase 2A

## Chạy local

```bash
pnpm install
pnpm dev
```

Mở `http://localhost:3000`.

Ảnh minh họa cho các phần Demo vẫn được đóng gói cục bộ. Asset Library dùng Secure Upload API và direct PUT tới private R2; chỉ tài nguyên đã được server xác minh mới có trạng thái `READY`.

## Kiểm tra

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Database Foundation (Phase 2A)

Schema PostgreSQL, migration, Prisma client và owner-scoped repository nằm trong
`packages/database`. Không có credential thật trong repository và ứng dụng web
chưa đọc/ghi database ở milestone này.

Để kiểm tra schema mà không cần database:

```bash
pnpm db:validate
pnpm db:generate
```

Để tự áp dụng migration vào database development do bạn quản lý:

```bash
cp packages/database/.env.example packages/database/.env
# thay DATABASE_URL placeholder bằng connection string development
pnpm db:migrate
```

Production database và production migration phải được người vận hành cấu hình,
phê duyệt và chạy thủ công.

## Authentication (Phase 2B)

Ứng dụng không có public registration. Sau khi migration 2B được áp dụng, người
vận hành tự cấu hình environment và chạy bootstrap OWNER trong terminal:

```bash
pnpm auth:bootstrap-owner
```

Xem hướng dẫn bảo mật và environment tại
[`packages/auth/README.md`](packages/auth/README.md). Không truyền mật khẩu qua
command-line argument và không đưa `.env` vào Git.

## Projects Management (Phase 2C)

`/projects` sử dụng PostgreSQL thật cho create, list, detail, edit,
archive và restore. Search, status filter, sort và pagination chạy tại database.
Mỗi read/mutation lấy owner từ session server-side; client không được chọn
`ownerId`. Update và lifecycle transition dùng `updatedAt` làm optimistic
concurrency token để tránh silent overwrite.

Project mới mặc định có type `MIXED`. Archive chỉ chuyển project sang read-only,
không xóa hoặc cascade asset/render job. Permanent delete không được cung cấp ở UI.
Milestone 2C không cần migration mới vì schema Phase 2A đã có đủ lifecycle fields
và owner-scoped indexes.

## Storage Foundation (Phase 2D-A)

`packages/assets` cung cấp Asset Service, private-storage contract, Cloudflare R2
adapter, upload/image policy, object-key strategy và lifecycle state machine. Đây
chỉ là server-side foundation: chưa có upload API/UI, không upload thật và unit
tests không cần R2 credential.

Migration 2D-A đã được operator áp dụng trên PostgreSQL development; automated
Asset integration xác nhận migration record và schema hoạt động. Xem đầy đủ cấu
hình, threat model và lifecycle tại [Storage Foundation](docs/STORAGE_FOUNDATION.md).

## Secure Upload API (Phase 2D-B)

Authenticated APIs đã hỗ trợ initiate, complete/verify và signed read URL. Upload
binary đi trực tiếp tới private R2 bằng presigned PUT; PostgreSQL chỉ chuyển Asset
sang `READY` sau HEAD, bounded read, magic/decode/dimension/pixel/checksum checks.
Quota, owner isolation, concurrent claim, retry recovery và one-shot cleanup CLI đã
được triển khai. Real R2 acceptance trên development bucket đã xác nhận PUT/HEAD/
GET/DELETE, CORS, owner isolation và cleanup. Xem [Secure Upload API](docs/SECURE_UPLOAD_API.md).

Thiết kế hardening staging/final, cleanup/recovery và private thumbnails cho Milestone 2D-D
đã được triển khai; migration đã được operator áp dụng trên development. Diagnostic probe
đã xác định và sửa offline lỗi tương thích checksum của final PUT; final real R2 acceptance
sau bản sửa vẫn chờ operator phê duyệt riêng. Xem
[Storage Security Hardening](docs/STORAGE_SECURITY_HARDENING.md).

## Asset Library UI (Phase 2D-C)

`/assets` đọc dữ liệu owner-scoped từ PostgreSQL với search/filter/sort/pagination
tại database. Upload UI dùng contract 2D-B, hiển thị progress/cancel, gọi complete
verification và chỉ preview/download `READY` bằng signed GET ngắn hạn. Delete là
logical request; object được dọn bởi maintenance job sau reference/key checks.

AI Image Studio chọn ảnh nguồn/reference/control map `READY` theo đúng Project;
đổi Project sẽ reset selection và Project archived là read-only. Không tạo
RenderJob hoặc gọi GPU. Xem [Asset Library guide](docs/ASSET_LIBRARY.md).

## Routes

- `/` — Dashboard
- `/image-studio` — AI Image Studio
- `/video-studio` — AI Video Studio
- `/workflow-studio` — Workflow Studio
- `/projects` — Projects
- `/jobs` — Job History
- `/gpu` — GPU Manager
- `/assets` — Asset Library
- `/settings` — Settings

## Trạng thái hiện tại

- Render Job và Job History dùng PostgreSQL thật. GPU/cost/provider telemetry vẫn có nhãn Demo hoặc `DISCONNECTED` cho tới khi có backend provider đáng tin cậy.
- PostgreSQL schema bao gồm user/session, project/asset, render job/event,
  workflow version, GPU allocation, provider usage và activity log.
- Repository dùng composite `id + ownerId` cho các lookup nhạy cảm và cung cấp
  transaction boundary dùng chung.
- Project, Asset Library và Render Job API/UI đã kết nối PostgreSQL; browser upload/preview dùng private R2. Worker/private gateway đã có mã nguồn và mock orchestration tests, nhưng GPU provisioning và real render chưa được chạy.
- Auth 2B bảo vệ route và OWNER do người vận hành bootstrap được dùng cho Project ownership.
- Không có API key hoặc secret trong source.
- Không tự gọi GPU, Vast.ai hoặc RunPod. ComfyUI chỉ được gọi khi operator chủ động khởi chạy private Docker V4.
- Docker V3 không bị sửa, di chuyển hoặc ghi đè.
- Xem [trạng thái triển khai](docs/IMPLEMENTATION_STATUS.md), [kiến trúc](docs/ARCHITECTURE.md), [GPU deployment](docs/GPU_DEPLOYMENT.md) và [runbook](docs/OPERATIONS_RUNBOOK.md).

## Các bước cấu hình thủ công

Không thêm credential vào Git. Khi Phase 2–4 bắt đầu, người vận hành sẽ tự cung cấp qua secret manager/environment của từng runtime:

- `DATABASE_URL` cho PostgreSQL development/production tương ứng
- auth secret/provider credentials
- Redis connection
- S3-compatible storage credentials
- Vast.ai / RunPod tokens
- Hugging Face token nếu model yêu cầu

Các giá trị này chỉ được đọc server-side và không được render về client.
