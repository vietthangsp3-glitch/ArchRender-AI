import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

type PrismaGlobal = typeof globalThis & {
  archRenderPrisma?: PrismaClient;
};

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required. Copy packages/database/.env.example to a local .env and provide a PostgreSQL connection string.",
    );
  }

  return databaseUrl;
}

export function createDatabaseClient(databaseUrl = requireDatabaseUrl()): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export function getDatabaseClient(): PrismaClient {
  const prismaGlobal = globalThis as PrismaGlobal;

  if (process.env["NODE_ENV"] === "production") {
    return createDatabaseClient();
  }

  prismaGlobal.archRenderPrisma ??= createDatabaseClient();
  return prismaGlobal.archRenderPrisma;
}

export type { PrismaClient } from "./generated/prisma/client";
