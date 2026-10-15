# Node UI Guide

The workflows in `/workflows` are API-format JSON. They are meant to reflect the actual node logic you should use in ComfyUI.

## Core architecture graph

### Workflow: Canny only
```text
LoadImage (source render)
 -> ImageScale
 -> VAEEncode
 -> KSampler
 -> VAEDecode
 -> UpscaleModelLoader
 -> ImageUpscaleWithModel
 -> ImageScale (3840x2160)
 -> SaveImage

LoadImage(source)
 -> ImageScale
 -> Canny
 -> ControlNetLoader(canny)
 -> ControlNetApplyAdvanced
 -> KSampler conditioning

CheckpointLoaderSimple
 -> CLIPTextEncode (positive)
 -> ControlNetApplyAdvanced
 -> KSampler

CheckpointLoaderSimple
 -> CLIPTextEncode (negative)
 -> ControlNetApplyAdvanced
 -> KSampler
```

### Workflow: Depth only
Same as above, but replace the canny branch with:
```text
LoadImage(depth)
 -> ImageScale
 -> ControlNetLoader(depth)
 -> ControlNetApplyAdvanced
```

### Workflow: Canny + Depth + Normal
Apply in this order:
1. Canny
2. Depth
3. Normal

This ordering works well because:
- Canny helps preserve edges
- Depth reinforces large-scale structure
- Normal refines surface direction and shape cues

## Main nodes you will edit in the UI
- `CLIPTextEncode` positive prompt
- `CLIPTextEncode` negative prompt
- `KSampler` denoise / steps / CFG / seed
- `ControlNetApplyAdvanced` strengths
- `ImageScale` final width / height

## Recommended editable items
### Positive prompt
- material feel
- daytime / dusk / warm interior
- premium vs minimalist styling
- atmosphere

### Negative prompt
- geometry damage
- distortion
- fake objects
- text/watermarks

### KSampler
- denoise: 0.22 to 0.32 usually safe
- steps: 24 to 32
- cfg: 5.0 to 6.0

### Control strengths
- canny: 0.6 to 0.8
- depth: 0.7 to 0.9
- normal: 0.25 to 0.5
