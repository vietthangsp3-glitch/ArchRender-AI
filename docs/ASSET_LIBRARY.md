# ArchRender AI — Asset Library & Image Studio (Milestone 2D-C)

## Phạm vi

Milestone 2D-C nối Premium Dark Studio hiện hữu với Asset API, PostgreSQL và private
Cloudflare R2. Không tạo RenderJob, không gọi GPU/ComfyUI và không thay đổi Docker
V3. Schema 2D-A đã đủ cho read management và logical deletion nên không có migration
mới.

## Sử dụng Asset Library

1. Mở `/assets` bằng session OWNER hợp lệ.
2. Chọn **Tải tài nguyên**, một Project `ACTIVE`, Asset Type và file JPEG/PNG/WebP.
3. UI pre-validate theo policy do `GET /api/assets` trả về, initiate một request ID,
   PUT trực tiếp tới R2 và hiển thị progress.
4. PUT thành công chưa phải hoàn tất. UI gọi complete; server HEAD, bounded-read,
   decode và checksum trước khi trả `READY`.
5. Search, Project/Type/Status filter, sort và pagination đều được thực hiện tại
   PostgreSQL. Browser không tải toàn bộ thư viện để tự lọc.
6. Card chỉ xin signed preview URL khi gần viewport. Detail cho phép download khi
   asset `READY`; URL ký không được hiển thị hay persist.
7. **Yêu cầu xóa** tạo logical tombstone. Scheduler/operator chạy maintenance để
   xóa object sau reference/key guard; HTTP DELETE không xóa R2 đồng bộ.

Project `ARCHIVED` cho phép xem và download asset READY nhưng không upload hoặc yêu
cầu xóa. Server enforce quy tắc này; disabled button chỉ là UX bổ sung.

## API tóm tắt

### `GET /api/assets`

Query allowlist:

- `projectId`: UUID.
- `assetType`: AssetType enum.
- `status`: trạng thái không bao gồm `DELETED`.
- `search`: tên file, tối đa 100 ký tự.
- `sort`: `newest`, `oldest`, `name`, `size`.
- `page`: 1–100000; `pageSize`: 1–24.

Response gồm DTO hiển thị và public upload policy. Không có bucket, object key,
checksum nội bộ, metadata hoặc signed URL hàng loạt.

### `GET /api/assets/{assetId}`

Trả detail tối thiểu theo `(assetId, principal.id)`. Asset đã delete hoặc thuộc
OWNER khác trả not-found.

### `DELETE /api/assets/{assetId}`

Yêu cầu session OWNER và trusted Origin/Host. Service serialize theo asset ID,
kiểm tra Project ACTIVE, RenderJob input/output reference, ghi ActivityLog rồi đổi
trạng thái sang `DELETED`. Retry cùng asset là idempotent.

## Image Studio

- Project selector dùng dữ liệu PostgreSQL thật, gồm cả Project archived có nhãn.
- Source picker hỗ trợ `SOURCE_IMAGE` và `REFERENCE_IMAGE`.
- Control picker hỗ trợ `DEPTH_MAP`, `NORMAL_MAP`, `CANNY_MAP`.
- Mỗi query bắt buộc `projectId`, `status=READY` và AssetType hiện chọn.
- Đổi Project hoặc control type reset selection cũ để không tạo cross-project state.
- Preview dùng signed GET như Asset Library. Project archived là read-only.
- Nút render vẫn ghi rõ Demo; không gọi execution backend.

## Upload troubleshooting

| Triệu chứng | Xử lý an toàn |
|---|---|
| File type/size bị từ chối trước upload | Chọn JPEG/PNG/WebP trong giới hạn policy trả từ backend. |
| CORS/network failure khi PUT | Không log URL ký; kiểm tra CORS development và retry bằng nút UI. |
| Upload contract hết hạn | UI tạo request ID mới khi backend xác nhận expiry; pending cũ do maintenance dọn. |
| PUT xong nhưng chưa READY | Không coi là thành công; chờ completion verification hoặc retry khi lỗi retryable. |
| `REJECTED` | File không khớp MIME/size/magic/decode/checksum; chọn lại file hợp lệ. |
| Storage unavailable | Giữ trạng thái recoverable và thử lại sau; không hiển thị raw R2 error. |
| Integrity conflict | Object READY đã thay đổi; preview/download bị fail-closed, cần operator điều tra. |
| Cancel | Abort PUT nếu đang truyền; pending record/object không hoàn tất được cleanup theo expiry. |

## Threat model và giới hạn đã biết

- Presigned PUT là bearer capability và có thể replay/overwrite cùng key trong TTL.
  R2 acceptance xác nhận hành vi này. HEAD/ETag guard chặn signed read sau thay đổi,
  nhưng không tạo immutability và vẫn có TOCTOU/denial-of-service window.
- Một preview URL đã cấp có thể dùng lại tới khi hết TTL. Authorization được kiểm tra
  lúc cấp URL; hiện chưa có cơ chế revoke URL đã phát hành.
- Original image được dùng làm preview vì chưa có thumbnail service. UI lazy-load và
  giới hạn page/concurrency tự nhiên của browser, nhưng ảnh lớn vẫn tốn bandwidth.
- Direct upload progress dựa trên XHR. Browser tự đặt `Content-Length`; server không
  tin declared size và luôn kiểm tra lại.
- Logical deletion phụ thuộc maintenance job để physical cleanup. Không chạy global
  cleanup trong request hoặc browser.
- PostgreSQL driver hiện cảnh báo semantics SSL sẽ đổi ở major version tương lai;
  operator nên giữ explicit `sslmode=verify-full` trong secret-managed connection.

Trước production nên ưu tiên immutable final object (staging + server-side copy),
R2 object version pinning hoặc upload gateway nonce một lần để giảm replay window;
đồng thời bổ sung thumbnail pipeline.

## Manual browser QA checkpoint

Chỉ thực hiện sau operator approval cho real browser R2 upload:

1. Restart Next dev process sau `pnpm db:generate` để tránh Prisma Client stale.
2. Login bằng OWNER do operator quản lý; không hardcode password.
3. Tạo/chọn Project test `ACTIVE` có tên dễ nhận diện.
4. Upload một PNG/JPEG fixture nhỏ không chứa dữ liệu riêng tư; xác nhận progress,
   VERIFYING rồi READY.
5. Refresh `/assets`, kiểm tra persistence, search/filter/sort/page, detail, preview
   và checksum/download bằng cách thủ công.
6. Chọn asset trong Image Studio, đổi Project và xác nhận selection reset.
7. Archive Project, xác nhận upload/delete/render Demo bị khóa nhưng read vẫn được.
8. Restore Project; request deletion cho fixture; chạy maintenance chỉ với scope đã
   review và xác nhận object/record test được cleanup.
9. Ghi lại exact asset/project IDs và số object tạo/xóa. Không dùng global cleanup.

## Ranh giới với Milestone 2E

2D-C chỉ quản lý và chọn asset. Render controls, prompt, style, GPU estimate và kết
quả gần đây vẫn là Demo. RenderJob creation, lineage mutation, queue/worker,
ComfyUI và GPU provider thuộc Milestone 2E hoặc phase sau.
