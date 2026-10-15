import type { Prisma } from "../generated/prisma/client";
import type { DatabaseClient, OwnerScope } from "../types";

export interface CreateActivityLogRecord extends OwnerScope {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  requestId?: string;
  ipHash?: string;
  metadata?: Prisma.InputJsonValue;
}

export class ActivityLogRepository {
  constructor(private readonly database: DatabaseClient) {}

  create(input: CreateActivityLogRecord) {
    return this.database.activityLog.create({ data: input });
  }

  list(ownerId: string, take = 100) {
    return this.database.activityLog.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(take, 1), 500),
    });
  }
}
