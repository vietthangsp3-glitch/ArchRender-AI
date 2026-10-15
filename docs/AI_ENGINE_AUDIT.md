# AI Engine Audit — Docker V3

Ngày audit: 14/10/2026  
Phạm vi: static review; **không build image, không tải model, không gọi GPU**.

## Kết luận

Docker V3 là launch kit hữu ích nhưng chưa production-ready. Ba workflow ảnh có JSON hợp lệ, không có node reference bị treo và hai script Python parse thành công. Docker Compose cũng resolve hợp lệ và chỉ publish ComfyUI qua `127.0.0.1` trên cấu hình local. Tuy nhiên build hiện không reproducible, model/custom node thiếu integrity pin, health/readiness chưa có, workflow Wan và tiled diffusion chỉ là ghi chú, Normal ControlNet chưa được xác minh tương thích, và API ComfyUI chưa có lớp bảo mật.

Không sửa bất kỳ file nào trong `arch-ai-cloud-v3` ở Phase 1.

## Inventory đã đọc

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore`
- `config/models-example.json`, `config/custom-nodes.json`
- `scripts/start.sh`, `download-models.py`, `install-custom-nodes.sh`, `render_arch.py`
- 3 workflow API JSON và 2 workflow notes
- README và toàn bộ tài liệu preset/node guide

## Điểm tốt có thể tái sử dụng

- Base CUDA/PyTorch runtime tách model khỏi image.
- `/workspace` được thiết kế cho persistent models/input/output/cache.
- Model downloader chỉ tải ID được chỉ định, tránh tải toàn bộ ngoài ý muốn.
- Compose local bind `127.0.0.1:8188`, phù hợp nguyên tắc không public ComfyUI.
- Canny/Depth/Normal graph tuần tự có cấu trúc rõ; output resize đúng 3840×2160.
- Script render hỗ trợ source/depth/normal, prompt và tham số cơ bản.
- Tài liệu thừa nhận rõ chưa có GPU end-to-end validation.

## Phát hiện và mức độ ưu tiên

### P0 — phải xử lý trước khi cho phép job production

1. **ComfyUI clone từ `master` mặc định.** Build cùng Dockerfile có thể tạo runtime khác nhau theo thời gian. Pin commit/tag đã kiểm thử và lưu SBOM/build metadata.
2. **Không có authentication/TLS cho ComfyUI API.** Bind localhost chỉ bảo vệ compose local; template GPU cloud có thể publish port khác. V4 cần private network hoặc authenticated gateway, allowlist endpoint và request signing/mTLS.
3. **Không có readiness/health check.** Process chạy không đồng nghĩa models/workflow sẵn sàng. Cần phân biệt container alive, ComfyUI ready, node schema ready, model files validated và workflow loadable.
4. **Model download không kiểm tra checksum/expected size.** Hugging Face cache giúp tải file nhưng manifest không có SHA-256, byte size, license hoặc revision. File sai/đổi upstream có thể chỉ lộ ra khi job chạy.
5. **Wan 2.2 chưa có workflow thực thi.** Manifest ba file và notes không đủ chứng minh pipeline I2V chạy được; thiếu workflow API/UI đã pin theo ComfyUI version và chưa xác nhận toàn bộ encoder/vision dependencies.

### P1 — chặn chất lượng hoặc khả năng vận hành ổn định

1. **Custom node không pin commit** và installer luôn `pull`; không cài `requirements.txt` riêng của node. Build/runtime có thể drift hoặc node không load.
2. **ComfyUI Manager được cài như convenience node.** Production image không nên có manager có khả năng tải/chạy code tùy ý; tách khỏi runtime production.
3. **Normal ControlNet chưa xác minh tương thích với SDXL base.** Model có nguồn khác Canny/Depth; cần xác nhận architecture, conditioning và chất lượng với checkpoint dùng thật.
4. **Không chuẩn hóa normal map.** Chưa quy định OpenGL vs DirectX (hướng kênh Y), color space, range và alpha; cùng một file có thể cho conditioning ngược.
5. **Không chuẩn hóa depth map.** Chưa quy định near/far inversion, linear/non-linear depth, bit depth hoặc preprocessing; resize Lanczos có thể không phù hợp với mọi map.
6. **“4K” hiện là ESRGAN upscale + resize**, không phải tiled diffusion upscale. `Ultimate SD Upscale` mới chỉ có notes, chưa có API JSON/node schema đã kiểm thử.
7. **Chỉ có API-format workflow.** Không có ComfyUI editor/UI JSON với positions/widget metadata; người dùng không thể import và chỉnh graph theo trải nghiệm đã mô tả mà không dựng lại.
8. **Không có workflow schema/version contract.** `render_arch.py` hard-code node IDs; thay workflow có thể làm `set_if_present` im lặng bỏ qua tham số.
9. **Không có output lifecycle protocol.** Script chỉ queue prompt, không websocket/poll status, không verify output, không upload object storage và không trả cost/error chuẩn hóa.

### P2 — hardening và tối ưu

1. Image chạy user root mặc định; cần non-root nếu compatibility cho phép.
2. Base image, apt packages và Python wheels chưa pin digest/version.
3. Không có resource limit, graceful drain hoặc cleanup temp/output.
4. `render_arch.py` nhận tùy ý `--server`; nếu được bọc trực tiếp bởi web request có thể tạo SSRF. Gateway phải dùng engine endpoint cấu hình server-side/allowlist, không nhận URL từ client.
5. Upload helper gửi `application/octet-stream`, chưa xác minh magic bytes, kích thước, dimension hay tên server-generated.
6. Log chưa có structured event, correlation/job ID hoặc secret redaction policy.
7. Không có license/redistribution inventory cho model và custom node.
8. Docker Compose chưa có healthcheck; `restart: unless-stopped` không giải quyết model corruption hoặc workflow incompatibility.

## Kiểm tra tĩnh đã thực hiện

| Kiểm tra | Kết quả |
| --- | --- |
| Parse `download-models.py`, `render_arch.py` bằng Python AST | Pass |
| Parse 3 workflow JSON | Pass |
| Kiểm tra node reference nội bộ | 0 dangling references |
| `docker compose config` | Pass |
| Build Docker image | Không chạy; sẽ clone/download dependency và không thuộc Phase 1 |
| GPU end-to-end | Không chạy theo yêu cầu |

Docker CLI báo không đọc được `C:\Users\Thang Nguyen\.docker\config.json` trong sandbox hiện tại; lỗi này không ảnh hưởng bước `compose config`, nhưng cần kiểm tra môi trường máy trước khi build V4.

## Kế hoạch Docker V4 — chưa triển khai

### 1. Reproducible image

- Pin base image digest, ComfyUI commit và custom-node commit.
- Multi-stage build; cài requirements của từng node; tạo SBOM.
- Tách `dev` image (Manager/UI) khỏi `runtime` image production.
- Chạy smoke test import/node discovery trong build CI.

### 2. Model manifest v4

- Zod/JSON Schema cho `id`, repo, revision, file, target, bytes, SHA-256, license, required/optional và VRAM tier.
- Atomic download vào temp, verify checksum/size rồi rename.
- Disk-space guard, retry có backoff, resumable download và manifest lock.
- Readiness trả về model version/hash thật.

### 3. Workflow bundle v4

- Mỗi workflow có API JSON + editor UI JSON + schema ánh xạ semantic parameter sang node/input.
- Pin workflow version và required node/model hashes.
- Validation với `/object_info` trước khi nhận job.
- Hoàn thiện: Depth preprocess, Normal convention adapters, Ultimate SD Upscale API graph và Wan 2.2 I2V graph.
- Golden fixtures cho source/depth/normal; regression test output metadata và graph validation.

### 4. Engine gateway

- Không expose port 8188 ra Internet.
- Gateway private có authentication, short-lived signed job token, allowlist method/path, payload limit và rate limit.
- Job ID/idempotency key, websocket/poll event mapping, timeout/cancel/drain.
- Download input bằng signed URL có SSRF guard; upload output qua signed destination.
- Structured logs có correlation ID, không log credential/prompt nhạy cảm tùy policy.

### 5. Readiness và GPU lifecycle

- `/live`: process sống.
- `/ready`: CUDA visible, VRAM tối thiểu, ComfyUI ready, required nodes present, model hashes pass, selected workflow validates.
- Warmup theo workflow; đo model-load state riêng với provider allocation state.
- Cost guard, idle timeout, max session budget, graceful stop và preemption recovery.

### 6. Ma trận kiểm thử GPU

- RTX 3090/4090 24 GB: Canny, Depth, Canny+Depth+Normal, 4K upscale.
- A6000/A100 nếu cần: Wan I2V và batch.
- Đo cold/warm latency, peak VRAM/RAM/disk, artifact, retry và actual cost.
- Chỉ đánh dấu production-ready khi golden run pass trên provider template thật.
