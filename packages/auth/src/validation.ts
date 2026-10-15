import { z } from "zod";

export const loginInputSchema = z.object({
  email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});

export const bootstrapOwnerInputSchema = z.object({
  email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(1).max(160).optional(),
  password: z.string().min(14).max(128),
});

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://archrender.invalid");
    if (url.origin !== "https://archrender.invalid") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
