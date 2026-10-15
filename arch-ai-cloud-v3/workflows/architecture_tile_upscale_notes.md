# Tile Upscale Notes (Ultimate SD Upscale)

This package does **not** include a fully validated API JSON for the custom node because exact node names and parameters can differ slightly by release.

However, V3 includes everything needed to prepare for tile upscale:

1. Install the custom node:
   ```bash
   bash /usr/local/bin/arch-ai-install-nodes
   ```
2. Restart ComfyUI.
3. In ComfyUI, use the following logic:

```text
Rendered image
  -> UpscaleModelLoader (4x-UltraSharp)
  -> ImageUpscaleWithModel
  -> ImageScale (optional exact size)
  -> Ultimate SD Upscale (No Upscale or standard variant)
  -> SaveImage
```

## Recommended settings for 24GB VRAM
- tile width: 768
- tile height: 768
- mask blur: 24
- padding: 32
- denoise: 0.12 to 0.22
- sampler: DPM++ 2M Karras
- steps: 12 to 20
- CFG: 4.5 to 6.0
- force uniform tiles: enabled

## Why use tile upscale?
- better local detail
- lower VRAM pressure than trying very large native diffusion passes
- useful for large interior/exterior client deliverables

## Practical advice
Start by running the normal 4K workflow first.
Only add tile upscale if:
- facade details still look too soft
- interior furniture / materials need more crispness
- your client wants more premium detail at close zoom
