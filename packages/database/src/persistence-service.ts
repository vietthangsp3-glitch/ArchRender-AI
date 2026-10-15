import type { PrismaClient } from "./generated/prisma/client";
import { ActivityLogRepository } from "./repositories/activity-log-repository";
import { AssetRepository } from "./repositories/asset-repository";
import { ProjectRepository } from "./repositories/project-repository";
import { RenderJobRepository } from "./repositories/render-job-repository";
import type { DatabaseClient } from "./types";

export class PersistenceContext {
  readonly projects: ProjectRepository;
  readonly assets: AssetRepository;
  readonly renderJobs: RenderJobRepository;
  readonly activityLogs: ActivityLogRepository;

  constructor(readonly database: DatabaseClient) {
    this.projects = new ProjectRepository(database);
    this.assets = new AssetRepository(database);
    this.renderJobs = new RenderJobRepository(database);
    this.activityLogs = new ActivityLogRepository(database);
  }
}

export class PersistenceService extends PersistenceContext {
  constructor(private readonly client: PrismaClient) {
    super(client);
  }

  transaction<T>(work: (context: PersistenceContext) => Promise<T>): Promise<T> {
    return this.client.$transaction((transaction) =>
      work(new PersistenceContext(transaction)),
    );
  }
}
