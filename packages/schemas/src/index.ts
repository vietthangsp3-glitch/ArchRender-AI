import { z } from "zod";

export const renderSettingsSchema = z.object({
  prompt: z.string().min(12).max(1200),
  negativePrompt: z.string().max(1200),
  seed: z.coerce.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  steps: z.coerce.number().int().min(10).max(80),
  cfg: z.coerce.number().min(1).max(20),
  denoise: z.coerce.number().min(0).max(1),
});

export type RenderSettings = z.infer<typeof renderSettingsSchema>;

export const projectNameSchema = z
  .string()
  .trim()
  .min(2, "Tên dự án cần ít nhất 2 ký tự")
  .max(80, "Tên dự án tối đa 80 ký tự");
