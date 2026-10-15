import { NextResponse } from "next/server";

import {
  expiredSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/cookie";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { getAuthService } from "@/lib/auth/server";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 403 });
  }
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  await getAuthService().logout(token);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", expiredSessionCookieOptions());
  response.headers.set("Cache-Control", "no-store");
  return response;
}
