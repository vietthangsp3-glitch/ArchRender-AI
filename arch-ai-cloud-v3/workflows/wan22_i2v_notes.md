# Wan 2.2 Image-to-Video Notes

This bundle prepares the **models and deployment structure** for Wan 2.2, but the exact editor workflow should be loaded from the official ComfyUI Wan 2.2 template inside ComfyUI because Wan workflows evolve quickly.

## Recommended process
1. Finish the still image first.
2. Open ComfyUI.
3. Browse templates / examples for **Wan 2.2 Image-to-Video 5B**.
4. Use the final still image as the image input.
5. Start with a short motion clip.

## Good starting settings
- duration: 3 to 5 seconds
- resolution: 480p or 720p
- camera motion: subtle
- prompt: movement only, not a redesign of architecture

## Example prompts
### Exterior orbit
"cinematic slow clockwise orbit around the villa, subtle parallax, preserve original architecture, no structural changes, stabilized camera, realistic motion"

### Interior dolly-in
"slow camera dolly into the living room, smooth motion, preserve furniture layout and architecture, realistic lighting, cinematic movement"

### Hallway slide
"gentle lateral camera slide through the hallway, preserve structure, no morphing, realistic motion, architectural visualization"

## Important warning
Single-image video can hallucinate unseen geometry.
For strict commercial delivery, prefer:
- multiple rendered angles from the 3D software, or
- modest camera movement only
