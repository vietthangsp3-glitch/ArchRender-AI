import type {
  Prisma,
  ProjectStatus,
  ProjectType,
} from "../generated/prisma/client";
import type { DatabaseClient, OwnerScope } from "../types";

export interface CreateProjectRecord extends OwnerScope {
  name: string;
  slug: string;
  description?: string | null;
  type: ProjectType;
}

export interface UpdateProjectRecord extends OwnerScope {
  id: string;
  name?: string;
  slug?: string;
  description?: string | null;
  type?: ProjectType;
  status?: ProjectStatus;
  archivedAt?: Date | null;
}

export interface ListProjectsRecord extends OwnerScope {
  search?: string;
  status?: ProjectStatus;
  sort: "createdAt" | "updatedAt" | "name";
  direction: "asc" | "desc";
  skip: number;
  take: number;
}

export class ProjectRepository {
  constructor(private readonly database: DatabaseClient) {}

  create(input: CreateProjectRecord) {
    return this.database.project.create({ data: input });
  }

  findById(ownerId: string, id: string) {
    return this.database.project.findUnique({
      where: { id_ownerId: { id, ownerId } },
      include: { _count: { select: { assets: true, renderJobs: true } } },
    });
  }

  findBySlug(ownerId: string, slug: string) {
    return this.database.project.findUnique({
      where: { ownerId_slug: { ownerId, slug } },
      include: { _count: { select: { assets: true, renderJobs: true } } },
    });
  }

  list(ownerId: string, status?: ProjectStatus) {
    return this.database.project.findMany({
      where: { ownerId, ...(status ? { status } : {}) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  }

  async listPage(input: ListProjectsRecord) {
    const where: Prisma.ProjectWhereInput = {
      ownerId: input.ownerId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.search
        ? { name: { contains: input.search, mode: "insensitive" } }
        : {}),
    };
    const orderBy: Prisma.ProjectOrderByWithRelationInput[] = [
      { [input.sort]: input.direction },
      { id: input.direction },
    ];
    const [items, total] = await Promise.all([
      this.database.project.findMany({
        where,
        orderBy,
        skip: input.skip,
        take: input.take,
        include: { _count: { select: { assets: true, renderJobs: true } } },
      }),
      this.database.project.count({ where }),
    ]);
    return { items, total };
  }

  update(input: UpdateProjectRecord) {
    const { id, ownerId, ...data } = input;
    return this.database.project.update({
      where: { id_ownerId: { id, ownerId } },
      data,
    });
  }

  updateIfCurrent(input: UpdateProjectRecord & { expectedUpdatedAt: Date }) {
    const { id, ownerId, expectedUpdatedAt, ...data } = input;
    return this.database.project.updateMany({
      where: { id, ownerId, updatedAt: expectedUpdatedAt },
      data,
    });
  }

  delete(ownerId: string, id: string) {
    return this.database.project.delete({
      where: { id_ownerId: { id, ownerId } },
    });
  }
}
