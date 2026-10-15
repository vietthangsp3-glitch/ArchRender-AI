import { requireRole, type AuthenticatedPrincipal } from "@archrender/auth";
import { Prisma, type PrismaClient } from "@archrender/database";

import { JobApplicationError } from "./errors";
import {
  createWorkflowSchema,
  idSchema,
  listWorkflowsSchema,
  updateWorkflowSchema,
  workflowConfigurationSchema,
} from "./schemas";

export class WorkflowService {
  constructor(private readonly database: PrismaClient) {}

  async create(principal: AuthenticatedPrincipal, input: unknown) {
    requireRole(principal, ["OWNER"]);
    const parsed = createWorkflowSchema.parse(input);
    if (parsed.configuration.kind !== parsed.kind) {
      throw new JobApplicationError("JOB_WORKFLOW_INVALID", "Workflow kind does not match its configuration.");
    }
    if (parsed.projectId) {
      const project = await this.database.project.findUnique({
        where: { id_ownerId: { id: parsed.projectId, ownerId: principal.id } },
      });
      if (!project) throw new JobApplicationError("JOB_PROJECT_NOT_FOUND", "Project not found.");
    }
    return this.database.workflowPreset.create({
      data: {
        ownerId: principal.id,
        ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
        name: parsed.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        kind: parsed.kind,
        status: "DRAFT",
        parameterSchemaVersion: parsed.parameterSchemaVersion,
        draftConfiguration: parsed.configuration,
      },
    });
  }

  async list(principal: AuthenticatedPrincipal, input: unknown) {
    requireRole(principal, ["OWNER"]);
    const parsed = listWorkflowsSchema.parse(input);
    return this.database.workflowPreset.findMany({
      where: {
        ownerId: principal.id,
        ...(parsed.kind ? { kind: parsed.kind } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
      },
      include: { versions: { orderBy: { version: "desc" }, take: 20 } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  }

  async get(principal: AuthenticatedPrincipal, workflowId: string) {
    requireRole(principal, ["OWNER"]);
    const id = idSchema.parse(workflowId);
    const workflow = await this.database.workflowPreset.findUnique({
      where: { id_ownerId: { id, ownerId: principal.id } },
      include: { versions: { orderBy: { version: "desc" }, take: 50 } },
    });
    if (!workflow) throw new JobApplicationError("JOB_NOT_FOUND", "Workflow not found.");
    return workflow;
  }

  async update(principal: AuthenticatedPrincipal, workflowId: string, input: unknown) {
    requireRole(principal, ["OWNER"]);
    const id = idSchema.parse(workflowId);
    const parsed = updateWorkflowSchema.parse(input);
    const current = await this.database.workflowPreset.findUnique({
      where: { id_ownerId: { id, ownerId: principal.id } },
    });
    if (!current || current.status === "ARCHIVED") {
      throw new JobApplicationError("JOB_NOT_FOUND", "Editable workflow not found.");
    }
    if (parsed.configuration && parsed.configuration.kind !== current.kind) {
      throw new JobApplicationError("JOB_WORKFLOW_INVALID", "Published workflow kind cannot change.");
    }
    return this.database.workflowPreset.update({
      where: { id_ownerId: { id, ownerId: principal.id } },
      data: {
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.configuration ? { draftConfiguration: parsed.configuration } : {}),
      },
    });
  }

  async publish(principal: AuthenticatedPrincipal, workflowId: string) {
    requireRole(principal, ["OWNER"]);
    const id = idSchema.parse(workflowId);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
      );
      const workflow = await transaction.workflowPreset.findUnique({
        where: { id_ownerId: { id, ownerId: principal.id } },
      });
      if (!workflow || workflow.status === "ARCHIVED") {
        throw new JobApplicationError("JOB_NOT_FOUND", "Workflow not found.");
      }
      const configuration = workflowConfigurationSchema.parse(workflow.draftConfiguration);
      if (configuration.kind !== workflow.kind) {
        throw new JobApplicationError("JOB_WORKFLOW_INVALID", "Workflow configuration is incompatible.");
      }
      const version = workflow.currentVersionNumber + 1;
      const published = await transaction.workflowVersion.create({
        data: {
          ownerId: principal.id,
          presetId: workflow.id,
          version,
          parameterSchemaVersion: workflow.parameterSchemaVersion,
          workflowReference: `database://workflows/${workflow.id}/versions/${version}`,
          parameters: configuration,
          compatibility: {
            jobType: workflow.kind,
            backend: configuration.backend,
            schemaVersion: workflow.parameterSchemaVersion,
          },
        },
      });
      await transaction.workflowPreset.update({
        where: { id_ownerId: { id: workflow.id, ownerId: principal.id } },
        data: { currentVersionNumber: version, status: "PUBLISHED" },
      });
      return published;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
