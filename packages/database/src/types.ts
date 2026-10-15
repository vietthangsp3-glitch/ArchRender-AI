import type { PrismaClient, Prisma } from "./generated/prisma/client";

export type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface OwnerScope {
  ownerId: string;
}
