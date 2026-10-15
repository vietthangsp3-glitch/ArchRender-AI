import { requireRole, type AuthenticatedPrincipal } from "@archrender/auth";
import {
  type PrismaClient,
  Prisma,
  ProjectRepository,
  ActivityLogRepository,
} from "@archrender/database";

import { ProjectApplicationError } from "./errors";
import {
  createProjectSchema,
  listProjectsSchema,
  projectIdSchema,
  projectTransitionSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type ListProjectsInput,
  type ProjectTransitionInput,
  type UpdateProjectInput,
} from "./schemas";
import type { ProjectListResult, ProjectSummary } from "./types";

function slugFor(requestId: string): string {
  return `project-${requestId.replaceAll("-", "")}`;
}

function toSummary(project: {
  id: string;
  name: string;
  description: string | null;
  type: "INTERIOR" | "EXTERIOR" | "MIXED";
  status: "ACTIVE" | "ARCHIVED";
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { assets: number; renderJobs: number };
}): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    type: project.type,
    status: project.status,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    assetCount: project._count.assets,
    renderJobCount: project._count.renderJobs,
  };
}

export class ProjectService {
  constructor(private readonly database: PrismaClient) {}

  async create(principal: AuthenticatedPrincipal, input: CreateProjectInput) {
    requireRole(principal, ["OWNER"]);
    const parsed = createProjectSchema.parse(input);
    const slug = slugFor(parsed.requestId);
    try {
      const project = await this.database.$transaction(async (transaction) => {
        const projects = new ProjectRepository(transaction);
        const created = await projects.create({
          ownerId: principal.id,
          name: parsed.name,
          slug,
          description: parsed.description,
          type: "MIXED",
        });
        await new ActivityLogRepository(transaction).create({
          ownerId: principal.id,
          actorUserId: principal.id,
          action: "PROJECT_CREATED",
          entityType: "PROJECT",
          entityId: created.id,
          requestId: parsed.requestId,
        });
        return projects.findById(principal.id, created.id);
      });
      if (!project) throw new ProjectApplicationError("PROJECT_NOT_FOUND", "Project not found.");
      return toSummary(project);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await new ProjectRepository(this.database).findBySlug(
          principal.id,
          slug,
        );
        if (existing) return toSummary(existing);
      }
      throw error;
    }
  }

  async list(
    principal: AuthenticatedPrincipal,
    input: ListProjectsInput,
  ): Promise<ProjectListResult> {
    const parsed = listProjectsSchema.parse(input);
    const result = await new ProjectRepository(this.database).listPage({
      ownerId: principal.id,
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.status === "ALL" ? {} : { status: parsed.status }),
      sort: parsed.sort,
      direction: parsed.direction,
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize,
    });
    return {
      items: result.items.map(toSummary),
      total: result.total,
      page: parsed.page,
      pageSize: parsed.pageSize,
      pageCount: Math.max(1, Math.ceil(result.total / parsed.pageSize)),
    };
  }

  async get(principal: AuthenticatedPrincipal, projectId: string) {
    const id = projectIdSchema.parse(projectId);
    const project = await new ProjectRepository(this.database).findById(principal.id, id);
    if (!project) throw new ProjectApplicationError("PROJECT_NOT_FOUND", "Project not found.");
    return toSummary(project);
  }

  async update(
    principal: AuthenticatedPrincipal,
    projectId: string,
    input: UpdateProjectInput,
  ) {
    requireRole(principal, ["OWNER"]);
    const id = projectIdSchema.parse(projectId);
    const parsed = updateProjectSchema.parse(input);
    return this.mutateCurrent(principal, id, new Date(parsed.expectedUpdatedAt), async (projects) => {
      const current = await projects.findById(principal.id, id);
      if (!current) throw new ProjectApplicationError("PROJECT_NOT_FOUND", "Project not found.");
      if (current.status === "ARCHIVED") {
        throw new ProjectApplicationError("PROJECT_ARCHIVED", "Archived projects are read-only.");
      }
      return {
        result: await projects.updateIfCurrent({
          ownerId: principal.id,
          id,
          expectedUpdatedAt: new Date(parsed.expectedUpdatedAt),
          name: parsed.name,
          description: parsed.description,
        }),
        action: "PROJECT_UPDATED",
      };
    });
  }

  archive(principal: AuthenticatedPrincipal, projectId: string, input: ProjectTransitionInput) {
    return this.transition(principal, projectId, input, "ACTIVE", "ARCHIVED");
  }

  restore(principal: AuthenticatedPrincipal, projectId: string, input: ProjectTransitionInput) {
    return this.transition(principal, projectId, input, "ARCHIVED", "ACTIVE");
  }

  private async transition(
    principal: AuthenticatedPrincipal,
    projectId: string,
    input: ProjectTransitionInput,
    from: "ACTIVE" | "ARCHIVED",
    to: "ACTIVE" | "ARCHIVED",
  ) {
    requireRole(principal, ["OWNER"]);
    const id = projectIdSchema.parse(projectId);
    const parsed = projectTransitionSchema.parse(input);
    return this.mutateCurrent(principal, id, new Date(parsed.expectedUpdatedAt), async (projects) => {
      const current = await projects.findById(principal.id, id);
      if (!current) throw new ProjectApplicationError("PROJECT_NOT_FOUND", "Project not found.");
      if (current.status !== from) {
        throw new ProjectApplicationError("PROJECT_INVALID_TRANSITION", "Invalid project transition.");
      }
      return {
        result: await projects.updateIfCurrent({
          ownerId: principal.id,
          id,
          expectedUpdatedAt: new Date(parsed.expectedUpdatedAt),
          status: to,
          archivedAt: to === "ARCHIVED" ? new Date() : null,
        }),
        action: to === "ARCHIVED" ? "PROJECT_ARCHIVED" : "PROJECT_RESTORED",
      };
    });
  }

  private async mutateCurrent(
    principal: AuthenticatedPrincipal,
    id: string,
    expectedUpdatedAt: Date,
    mutation: (
      projects: ProjectRepository,
    ) => Promise<{ result: { count: number }; action: string }>,
  ) {
    return this.database.$transaction(async (transaction) => {
      const projects = new ProjectRepository(transaction);
      const { result, action } = await mutation(projects);
      if (result.count !== 1) {
        const exists = await projects.findById(principal.id, id);
        if (!exists) throw new ProjectApplicationError("PROJECT_NOT_FOUND", "Project not found.");
        throw new ProjectApplicationError("PROJECT_CONFLICT", "Project changed since it was loaded.");
      }
      await new ActivityLogRepository(transaction).create({
        ownerId: principal.id,
        actorUserId: principal.id,
        action,
        entityType: "PROJECT",
        entityId: id,
        metadata: { expectedUpdatedAt: expectedUpdatedAt.toISOString() },
      });
      const updated = await projects.findById(principal.id, id);
      if (!updated) throw new ProjectApplicationError("PROJECT_NOT_FOUND", "Project not found.");
      return toSummary(updated);
    });
  }
}
