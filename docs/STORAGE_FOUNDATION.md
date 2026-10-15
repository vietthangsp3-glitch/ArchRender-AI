# ArchRender AI — Storage Foundation (Milestone 2D-A)

## Trạng thái và phạm vi

2D-A ban đầu triển khai foundation server-side. Các lớp tiếp theo đã bổ sung Secure
Upload API/cleanup (2D-B) và Asset Library/Image Studio UI (2D-C). Unit tests không
gọi R2; real R2 development acceptance được chạy riêng có kiểm soát.

Đã triển khai và unit-tested:

- Asset service chuẩn bị upload theo authenticated OWNER và Project ownership.
- `StorageProvider` contract và Cloudflare R2 adapter dùng AWS SDK v3.
- Upload intent policy, filename sanitization, MIME/extension/magic-byte checks.
- Decode JPEG/PNG/WebP bằng Sharp với giới hạn byte, dimension và decoded pixels.
- Server-generated object keys, lifecycle state machine và idempotency request key.
- Stable storage errors và redaction cho dữ liệu nhạy cảm.

2D-B đã integration-test HEAD/completion/cleanup flow trên PostgreSQL development
và real R2 API acceptance. Presigned PUT qua browser thật vẫn chờ manual 2D-C QA.

## Kiến trúc

```text
Future Route Handler
  -> authenticated principal (không nhận ownerId từ client)
  -> AssetService
     -> ProjectRepository / AssetRepository -> Prisma / PostgreSQL
     -> StorageProvider -> R2StorageProvider -> private R2 bucket
```

`AssetService` tạo asset ID và object key trước khi ký. Bucket/key không phải input
từ client. Database transaction chỉ bao phủ metadata và activity log; không giả
lập distributed transaction với R2. Nếu việc ký lỗi, record `PENDING_UPLOAD` còn
lại và retry cùng request ID có thể tiếp tục an toàn trong thời hạn.

## StorageProvider contract

- Tạo presigned PUT có content type, content length, metadata và TTL bị giới hạn.
- Tạo presigned GET ngắn hạn.
- HEAD object và existence check.
- Đọc object với byte range, đồng thời từ chối nếu provider trả quá giới hạn.
- Xóa object bằng key đã được service kiểm soát.

R2 adapter dùng region `auto`, endpoint HTTPS theo account, `maxAttempts=3`,
connection timeout 3 giây và request timeout 15 giây. Bucket phải private; không
có public URL. Adapter không log request, signed URL, credential hoặc provider
message. Không import AWS SDK vào React Client Component.

## Object key

```text
{environment}/owners/{ownerId}/projects/{projectId}/assets/{assetId}/{random128bit}
```

Mọi ID phải là UUID hợp lệ; random suffix là 128 bit. Filename gốc không xuất hiện
trong key, chỉ được lưu dưới dạng metadata đã sanitize. Prefix hỗ trợ truy vết và
cleanup nhưng không thay thế authorization tại application layer.

## Upload và image policy

- Asset type: `SOURCE_IMAGE`, `REFERENCE_IMAGE`, `DEPTH_MAP`, `NORMAL_MAP`,
  `CANNY_MAP`.
- Format: JPEG, PNG, WebP.
- Mặc định tối đa 25 MiB, dimension 16,384 và 100 triệu decoded pixels.
- Extension, declared MIME, magic bytes và decoded format phải đồng nhất.
- Bounded storage read yêu cầu tối đa `maxUploadBytes`; Sharp dùng
  `limitInputPixels`, sequential read và fail-on-warning.
- Client-provided size/MIME/name chỉ là intent. Completion ở 2D-B bắt buộc HEAD,
  bounded download, decode và checksum trước khi chuyển `READY`.

## Lifecycle

```text
PENDING_UPLOAD -> VERIFYING -> READY
       |              |  \-> REJECTED
       |              \----> PENDING_UPLOAD (retry lỗi tạm thời)
       \-> REJECTED -> PENDING_UPLOAD (upload lại)
PENDING_UPLOAD / VERIFYING / REJECTED -> DELETED
READY -> DELETED chỉ khi không còn RenderJobInput/Output tham chiếu
```

- Duplicate transition cùng trạng thái là idempotent.
- Claim verification tại DB phải dùng conditional update từ `PENDING_UPLOAD` sang
  `VERIFYING`; chỉ một caller nhận `count=1`.
- `uploadExpiresAt` phân biệt upload chưa hoàn tất/hết hạn.
- `verificationAttempts` và `verificationStartedAt` hỗ trợ reclaim sau transient
  failure; timeout/retry policy cụ thể thuộc worker 2D-B.
- Không chuyển `READY` trước khi binary đã xác minh.
- `DELETED` là tombstone; xóa object vật lý chỉ diễn ra sau reference check và
  retryable cleanup policy.

## Threat model và yêu cầu bắt buộc cho 2D-B

| Rủi ro | Foundation 2D-A | Bắt buộc ở 2D-B |
|---|---|---|
| Presigned PUT replay | TTL 30–900 giây, random immutable-intent key | Completion một lần; không ký lại sau claim/expiry |
| Object overwrite | Key có asset UUID + random 128 bit | HEAD metadata/checksum; từ chối completion trùng hoặc mismatch |
| Size bypass | PUT ký content length; bounded read | HEAD size rồi stream tối đa limit + 1; reject và cleanup |
| MIME spoof/decompression bomb | Magic + decoder + pixel/dimension limits | Chạy verification server-side trước `READY` |
| Orphan object | Prefix truy vết, pending expiry fields | Scheduled cleanup idempotent với grace period và audit |
| Concurrent completion | Conditional lifecycle repository method | Transaction claim `PENDING_UPLOAD -> VERIFYING` |
| Cross-owner/project access | Principal-derived owner, composite owner keys | Mọi API lookup owner-scoped; không nhận owner/key/bucket từ client |
| Referenced deletion | FK `Restrict`, lifecycle guard | Reference query + tombstone + asynchronous object cleanup |

Presigned URLs là bearer capability và tuyệt đối không được ghi log. Error response
chỉ dùng stable code; provider stack/message không trả về client.

## Cấu hình R2 thủ công

Sao chép placeholder từ `apps/web/.env.example` vào secret store/environment của
runtime server. Không commit giá trị thật. Cần cấu hình:

- `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- `R2_ENDPOINT` là tùy chọn và phải khớp HTTPS host của account.
- `ASSET_STORAGE_ENVIRONMENT`: `development`, `staging` hoặc `production`.
- Các giới hạn upload/dimension/pixel và TTL trong range 30–900 giây.

Người vận hành tự tạo private bucket và token tối thiểu quyền object read/write cho
bucket đó. 2D-A không kiểm tra credential hoặc cloud connectivity.

## Migration review checkpoint

Migration đã được operator review và áp dụng trên PostgreSQL development:
`packages/database/prisma/migrations/20261014000300_phase_2d_a_storage_foundation/migration.sql`.

Migration chỉ thêm enum value, nullable columns, một counter có default, unique
idempotency index và expiry index; không đổi/xóa dữ liệu cũ. Trước khi áp dụng:

1. Backup/point-in-time recovery phải sẵn sàng và review SQL.
2. Xác nhận không có duplicate non-null `(ownerId, uploadRequestId)`.
3. Chạy `pnpm db:migrate:deploy` bằng operator trong development trước.
4. Chạy PostgreSQL integration tests và smoke query sau migration.
5. Production chỉ thực hiện trong change window đã phê duyệt.

Không dùng `prisma migrate reset` hoặc `prisma db push`.
