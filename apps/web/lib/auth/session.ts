import "server-only";

import type { SessionUser } from "@archrender/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME } from "./cookie";
import { getAuthService } from "./server";

export async function getRequestSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const result = await getAuthService().validateSession(token, { rotate: false });
  return result.status === "valid" ? result.user : null;
}

export async function requirePageSession(): Promise<SessionUser> {
  const user = await getRequestSession();
  if (!user) redirect("/login");
  return user;
}
