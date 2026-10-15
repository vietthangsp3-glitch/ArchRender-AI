# Arch AI Cloud V3 — ComfyUI Docker for Architecture Render + Wan 2.2 Video

This package is designed so you can **prepare once** and later rent a GPU to quickly generate:

1. **Architecture / interior / exterior images** using SDXL img2img.
2. **Structure-preserving passes** using Canny, Depth, and optional Normal Map.
3. **4K output** with a simple upscale path or tiled upscale path.
4. **Image-to-video** using Wan 2.2.
5. **Editable ComfyUI workflows** so you can change prompt, material, lighting, denoise, and control strengths.

The image contains **software only**. Large model weights are **not baked into the Docker image**. They live under `/workspace/models` so you can persist them if your GPU provider supports durable storage.

---

## What is included in V3

### Runtime / deployment
- Dockerfile based on PyTorch CUDA runtime
- ComfyUI installation
- `/workspace` persistence layout (`models`, `input`, `output`, `user`, `custom_nodes`, `temp`)
- helper script to download models from Hugging Face
- helper script to install/update custom nodes
- starter Docker Compose for ordinary Linux Docker hosts

### Image render workflows
- `architecture_canny_4k_api.json`
- `architecture_depth_4k_api.json`
- `architecture_canny_depth_normal_4k_api.json`
- prompt presets for daylight / dusk / warm interior / luxury material emphasis

### Upscale / 4K
- standard 4x UltraSharp upscale workflow
- integration guide for **Ultimate SD Upscale** custom node (tile upscale)
- recommended tile settings for 24GB VRAM

### Video
- Wan 2.2 model manifest entries
- Wan 2.2 workflow integration notes and quick-start guide
- recommended flow: image render first, then short 3–5s or 5–8s camera motion video

### Node-UI editing support
- node map guide (`docs/NODE_UI_GUIDE.md`)
- parameter guide (`docs/PRESET_PARAMETERS.md`)
- workflow notes to help you edit prompt, negative prompt, denoise, strengths, lighting, and output size directly in ComfyUI

---

## Important honesty note

This is a **prepared starter bundle**. It is more complete than V2, but it has **not been end-to-end validated on a real rented GPU** from this environment.

So think of V3 as:
- a **much better launch kit**,
- with the right files and structure,
- but still needing **one real test run** on an RTX 3090 / 4090 instance before using it for client delivery.

That is normal for ComfyUI-based production stacks.

---

## Recommended usage flow for your job

### A. Render still image
1. Start GPU container.
2. Download required models once.
3. Open ComfyUI.
4. Load one of the architecture workflows.
5. Upload:
   - source render,
   - optional depth map from SketchUp / Blender / 3ds Max / V-Ray,
   - optional normal map from the 3D software.
6. Edit prompt / material / lighting.
7. Generate preview.
8. Generate final 4K.

### B. Create video after final image
1. Use final architecture image as the input.
2. Load official Wan 2.2 image-to-video workflow.
3. Use a short camera movement prompt (orbit / dolly / slide / push-in).
4. Generate short clip first.
5. If good, rerun with final settings.

---

## Folder structure

```text
arch-ai-cloud-v3/
  Dockerfile
  docker-compose.yml
  README.md
  config/
    models-example.json
    custom-nodes.json
  scripts/
    start.sh
    download-models.py
    install-custom-nodes.sh
    render_arch.py
  workflows/
    architecture_canny_4k_api.json
    architecture_depth_4k_api.json
    architecture_canny_depth_normal_4k_api.json
    architecture_tile_upscale_notes.md
    wan22_i2v_notes.md
  docs/
    NODE_UI_GUIDE.md
    PRESET_PARAMETERS.md
    PROMPT_PRESETS.md
```

---

## 1) Build your Docker image once

Build from a machine where Docker is available:

```bash
docker build -t YOUR_DOCKER_USER/arch-ai-comfy:v3 .
docker push YOUR_DOCKER_USER/arch-ai-comfy:v3
```

Then in Vast.ai / RunPod, create a template using this image.

---

## 2) Start container and persistent storage

Recommended:
- mount durable storage to `/workspace`
- allocate at least **100–150GB** if you want SDXL + ControlNet + Wan + outputs
- prefer **RTX 4090 24GB** or **RTX 3090 24GB**

If you cannot keep `/workspace`, you will need to re-download models later.

---

## 3) Download required models

Inside the running container:

```bash
python /usr/local/bin/arch-ai-models /opt/models-example.json --list
```

### Minimal image render set
```bash
python /usr/local/bin/arch-ai-models /opt/models-example.json \
  --only sdxl-base \
  --only sdxl-canny \
  --only 4x-ultrasharp
```

### Better architecture set
```bash
python /usr/local/bin/arch-ai-models /opt/models-example.json \
  --only sdxl-base \
  --only sdxl-canny \
  --only sdxl-depth \
  --only sdxl-normal \
  --only 4x-ultrasharp
```

### Wan 2.2 starter set
```bash
python /usr/local/bin/arch-ai-models /opt/models-example.json \
  --only wan22-5b \
  --only wan22-vae \
  --only wan-text-encoder
```

> Notes:
> - `sdxl-normal` is optional and heavier.
> - For strict architecture work, **Depth** is usually the most important after Canny.
> - Normal Map helps preserve surface direction and material transitions if your input maps are good.

---

## 4) Install tile-upscale custom node

Run once inside the container:

```bash
bash /usr/local/bin/arch-ai-install-nodes
```

This installs:
- ComfyUI-Manager (optional convenience)
- ComfyUI_UltimateSDUpscale

After installation, restart ComfyUI.

---

## 5) Which workflow should you load?

### `architecture_canny_4k_api.json`
Use when you only have a source render image.

### `architecture_depth_4k_api.json`
Use when you have:
- source render image
- depth map from the 3D software

### `architecture_canny_depth_normal_4k_api.json`
Use when you have:
- source render image
- depth map
- normal map

This is the most complete architecture still-image preset in this bundle.

---

## 6) Render by API helper (optional)

You can also queue workflows by script instead of only using the UI.

### Basic example
```bash
python scripts/render_arch.py source.png \
  --server http://127.0.0.1:8188 \
  --workflow workflows/architecture_canny_4k_api.json
```

### With depth map
```bash
python scripts/render_arch.py source.png \
  --depth-map depth.png \
  --server http://127.0.0.1:8188 \
  --workflow workflows/architecture_depth_4k_api.json
```

### With depth + normal map
```bash
python scripts/render_arch.py source.png \
  --depth-map depth.png \
  --normal-map normal.png \
  --server http://127.0.0.1:8188 \
  --workflow workflows/architecture_canny_depth_normal_4k_api.json
```

---

## 7) Recommended 24GB VRAM strategy

### Fast preview
- base size: `1344x768`
- steps: `24–30`
- denoise: `0.22–0.32`
- canny/depth strength: `0.55–0.85`
- normal strength: `0.25–0.5`

### Final still image
- generate base frame first
- upscale with 4x UltraSharp
- resize to `3840x2160`
- if more detail is needed, use **Ultimate SD Upscale** with tiles

### Good tile settings for 24GB VRAM
- tile width: `768`
- tile height: `768`
- mask blur: `16–32`
- denoise: `0.12–0.25`
- force uniform tiles: `true`

---

## 8) Wan 2.2 usage recommendation

Do **not** start with long videos.

Start with:
- 3–5 seconds
- 480p or 720p
- gentle orbit / dolly / push-in motion

For architecture, small camera motion is safer than dramatic 180–360° moves from a single image.

See: `workflows/wan22_i2v_notes.md`

---

## 9) Security

- Do **not** expose ComfyUI port publicly without authentication.
- Prefer SSH tunnel or private access.
- Do **not** embed Hugging Face tokens or provider secrets in the repo or image.
- Check storage billing separately from GPU billing.

---

## 10) Suggested next step

When you rent the GPU later, test in this order:
1. `architecture_canny_4k_api.json`
2. `architecture_depth_4k_api.json`
3. `architecture_canny_depth_normal_4k_api.json`
4. tile upscale
5. Wan 2.2 short image-to-video clip

That gives you the fastest path to a usable commercial workflow.
