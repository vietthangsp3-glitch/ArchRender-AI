import { NextResponse } from "next/server";

import {
  expiredSessionCookieOptions,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/cookie";
import { getAuthService } from "@/lib/auth/server";

export async function GET(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  const result = await getAuthService().validateSession(token, { rotate: true });
  if (result.status !== "valid") {
    const response = NextResponse.json({ ok: false }, { status: 401 });
    response.cookies.set(SESSION_COOKIE_NAME, "", expiredSessionCookieOptions());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  const response = NextResponse.json({ ok: true, user: result.user });
  if (result.rotatedToken) {
    response.cookies.set(
      SESSION_COOKIE_NAME,
      result.rotatedToken,
      sessionCookieOptions(result.expiresAt),
    );
  }
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}
