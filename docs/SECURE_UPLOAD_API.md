# ArchRender AI — Secure Upload API (Milestone 2D-B)

## Phạm vi đã triển khai

2D-B nối authenticated Next.js API với `AssetService`, PostgreSQL và
`StorageProvider`. Real R2 development acceptance đã xác nhận request path và
cleanup. Asset Library và Image Studio được nối trong Milestone 2D-C.

```text
Authenticated Request
  -> Next.js Route Handler (session + Origin + bounded JSON)
  -> AssetService (owner/project policy + quota + lifecycle)
  -> AssetRepository / StorageProvider
  -> PostgreSQL / private R2 bucket
```

## API contracts

### `POST /api/assets/uploads`

Mutation yêu cầu session OWNER và trusted Origin. Body tối đa 16 KiB:

```json
{
  "requestId": "client-generated UUID",
  "projectId": "UUID",
  "assetType": "SOURCE_IMAGE",
  "originalName": "source.png",
  "contentType": "image/png",
  "byteSize": 12345
}
```

Không nhận `ownerId`, bucket hoặc object key. Response `201` trả asset ID và
presigned PUT contract gồm URL, expiry và required headers. Response luôn
`private, no-store`. Idempotency key unique theo OWNER và bị ràng buộc với toàn bộ
payload; tái sử dụng cho payload khác trả conflict.

### Direct PUT

`uploadDirectlyToStorage()` dùng `XMLHttpRequest` để có progress, timeout và abort.
Client áp dụng signed headers nhưng bỏ `Content-Length` vì browser tự quản lý header
này. Không log signed URL. HTTP PUT thành công chỉ có nghĩa object đã tồn tại, chưa
phải asset `READY`.

### `POST /api/assets/{assetId}/complete`

Body tùy chọn gồm `etag` và `checksumSha256`. Service atomically claim
`PENDING_UPLOAD -> VERIFYING`, sau đó HEAD và bounded-read object, so sánh
size/MIME/asset metadata/ETag, decode JPEG/PNG/WebP, kiểm tra dimension/pixel limit
và tính SHA-256. Chỉ khi tất cả pass mới transactionally ghi `READY` và ActivityLog.
Invalid binary thành `REJECTED`; storage failure tạm thời trả asset về
`PENDING_UPLOAD`. Duplicate completion của asset `READY` là idempotent.

### `GET /api/assets/{assetId}/read-url`

Yêu cầu session, lookup bằng `(assetId, principal.id)` và chỉ cấp URL cho `READY`.
Trước khi ký GET, service HEAD object và so sánh ETag đã lưu lúc verification để
phát hiện overwrite sau finalize. Response private/no-store, TTL tối đa theo config.

### Asset Library read/delete APIs

- `GET /api/assets`: project/type/status/search/sort/page/pageSize allowlist; query,
  ordering và pagination chạy ở PostgreSQL. Response không trả storage key/metadata.
- `GET /api/assets/{assetId}`: detail tối thiểu, owner-scoped, private/no-store.
- `DELETE /api/assets/{assetId}`: session OWNER + trusted Origin; chặn Project
  archived và RenderJob lineage reference; ghi `ASSET_DELETION_REQUESTED` cùng
  logical tombstone. Object chỉ được xóa bởi maintenance job.

## Quota và concurrency

Initiate dùng PostgreSQL transaction và owner-derived advisory lock để serialize
reservation cùng OWNER. Trong lock, service kiểm tra số initiate/phút, số
`PENDING_UPLOAD` + `VERIFYING`, và tổng reserved/actual bytes của
`PENDING_UPLOAD`, `VERIFYING`, `READY`.

Defaults development: 20 initiate/phút, 8 concurrent upload, 10 GiB/OWNER.
Giới hạn được cấu hình server-side; client không thể chọn quota.

## Recovery và cleanup

`AssetMaintenanceService` và lệnh `pnpm --filter @archrender/assets cleanup` là
job one-shot để scheduler/operator gọi; không giả định Next.js có background loop.

- Reclaim `VERIFYING` quá stale về `PENDING_UPLOAD`.
- Xóa object của upload hết hạn và asset `REJECTED`.
- Xóa object của asset đã nhận logical deletion request, sau đó đánh dấu thời điểm
  physical cleanup để lần chạy sau idempotent.
- `NoSuchKey` được coi là cleanup idempotent.
- Delete lỗi giữ nguyên DB state để lần sau retry.
- Trước delete: kiểm tra bucket, exact environment/owner/project/asset key prefix,
  random suffix và RenderJob input/output references.
- Chỉ chuyển DB sang `DELETED` sau khi object delete thành công hoặc đã không tồn tại.

CLI này có thể gọi R2 thật, vì vậy không chạy trong automated gates và chỉ được
operator/scheduler kích hoạt sau khi phê duyệt cloud operations.

## Threat assessment

### Presigned PUT replay/overwrite

URL là bearer capability, có thể replay và overwrite cùng key cho tới khi hết hạn.
2D-B giảm rủi ro bằng random key, TTL ngắn, server-side completion một lần, lưu
ETag + SHA-256 và HEAD/ETag check trước signed read. Không thể thu hồi một presigned
URL đã phát hành. Consumer/render worker tương lai cũng phải kiểm tra ETag/checksum.

### Size bypass

PUT ký declared content length nhưng đây không phải quota enforcement tuyệt đối ở
mọi browser/R2 path. Browser tự đặt `Content-Length`. Server chỉ công nhận upload
sau HEAD exact-size và bounded read tối đa limit; object quá lớn không bao giờ
`READY` và được cleanup sau reject.

### Other risks

- MIME/extension spoof: magic bytes và decoder format phải khớp.
- Decompression bomb: encoded bytes, dimension và decoded pixels đều bị giới hạn.
- Cross-owner/project: owner chỉ đến từ session; repository dùng composite owner key.
- Race/lost response: conditional status transition và READY idempotency.
- Crash khi VERIFYING: maintenance reclaim sau stale threshold.
- Orphan/delete failure: retryable one-shot cleanup; không xóa referenced asset.
- Signed URLs, cookie, token, credential và provider details không được ghi log.

## R2/CORS requirements

Development runtime đọc `R2_BUCKET_NAME` từ environment; tên bucket không hardcode.
Bucket phải private và token chỉ có Object Read & Write cho đúng bucket.

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type", "x-amz-meta-assetid"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## Real R2 acceptance và browser checkpoint

2D-B real R2 acceptance đã PASS với fixture không riêng tư và exact cleanup. 2D-C
không chạy thêm cloud operation tự động. Real browser upload vẫn cần operator
approval riêng:

1. Tạo một test project/asset có prefix nhận diện riêng.
2. Initiate một PNG nhỏ, thực hiện một presigned PUT, complete, signed GET và đối
   chiếu checksum.
3. Test MIME spoof/oversize bằng object test riêng và chạy cleanup exact asset IDs.
4. Xác nhận CORS preflight, ETag exposure, expiry và owner isolation.
5. Xóa mọi object/record của test run; không dùng OWNER data hiện hữu ngoài project
   test được chỉ định.

Không dùng OWNER password trong source/test, không upload ảnh riêng tư và chỉ xóa
exact object/record do browser QA tạo.
