import { z } from "zod";

const normalizedName = z
  .string()
  .trim()
  .min(2, "Tên dự án cần ít nhất 2 ký tự.")
  .max(80, "Tên dự án tối đa 80 ký tự.");

const normalizedDescription = z
  .string()
  .trim()
  .max(2_000, "Mô tả tối đa 2.000 ký tự.")
  .transform((value) => value || null);

export const projectIdSchema = z.uuid();

export const createProjectSchema = z.object({
  name: normalizedName,
  description: normalizedDescription.optional().default(null),
  requestId: z.uuid(),
});

export const updateProjectSchema = z.object({
  name: normalizedName,
  description: normalizedDescription.optional().default(null),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});

export const projectTransitionSchema = z.object({
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});

export const listProjectsSchema = z.object({
  search: z.string().trim().max(100).optional().default(""),
  status: z.enum(["ALL", "ACTIVE", "ARCHIVED"]).optional().default("ACTIVE"),
  sort: z.enum(["createdAt", "updatedAt", "name"]).optional().default("updatedAt"),
  direction: z.enum(["asc", "desc"]).optional().default("desc"),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(24).optional().default(12),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;
export type ProjectTransitionInput = z.input<typeof projectTransitionSchema>;
export type ListProjectsInput = z.input<typeof listProjectsSchema>;
