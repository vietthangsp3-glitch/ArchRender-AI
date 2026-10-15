import type { Prisma, PrismaClient } from "@archrender/database";

import { hashPassword, validatePasswordPolicy } from "./password";
import { bootstrapOwnerInputSchema } from "./validation";

export type BootstrapOwnerResult =
  | { status: "created"; userId: string }
  | { status: "already_bootstrapped" };

export async function bootstrapOwner(
  database: PrismaClient,
  input: { email: string; password: string; displayName?: string },
): Promise<BootstrapOwnerResult> {
  const parsed = bootstrapOwnerInputSchema.parse(input);
  const passwordErrors = validatePasswordPolicy(parsed.password);
  if (passwordErrors.length > 0) throw new Error(passwordErrors[0]);
  const passwordHash = await hashPassword(parsed.password);

  try {
    return await database.$transaction(async (transaction) => {
      const existingOwner = await transaction.user.findFirst({
        where: { OR: [{ role: "OWNER" }, { ownerSingletonKey: "PRIMARY" }] },
        select: { id: true },
      });
      if (existingOwner) return { status: "already_bootstrapped" } as const;

      const owner = await transaction.user.create({
        data: {
          email: parsed.email,
          passwordHash,
          displayName: parsed.displayName ?? null,
          role: "OWNER",
          ownerSingletonKey: "PRIMARY",
        },
      });
      await transaction.activityLog.create({
        data: {
          ownerId: owner.id,
          actorUserId: owner.id,
          action: "AUTH_OWNER_BOOTSTRAPPED",
          entityType: "USER",
          entityId: owner.id,
        },
      });
      return { status: "created", userId: owner.id } as const;
    });
  } catch (error) {
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    if (prismaError.code === "P2002") return { status: "already_bootstrapped" };
    throw error;
  }
}
