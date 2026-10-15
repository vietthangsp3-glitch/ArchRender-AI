import { safeReturnTo } from "@archrender/auth";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/cookie";
import { classifyLoginFailure, logLoginFailure } from "@/lib/auth/diagnostics";
import { getClientAddress, isTrustedMutationRequest } from "@/lib/auth/request-security";
import { getAuthService } from "@/lib/auth/server";

const GENERIC_ERROR = "Email hoặc mật khẩu không hợp lệ.";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    logLoginFailure("request_parse", "AUTH_REQUEST_INVALID_JSON");
    return NextResponse.json(
      { ok: false, error: "Yêu cầu không hợp lệ." },
      { status: 400 },
    );
  }

  try {
    const userAgent = request.headers.get("user-agent");
    const result = await getAuthService().login({
      email: typeof body["email"] === "string" ? body["email"] : "",
      password: typeof body["password"] === "string" ? body["password"] : "",
      ipAddress: getClientAddress(request),
      ...(userAgent ? { userAgent } : {}),
    });
    if (result.status === "blocked") {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.retryAt.getTime() - Date.now()) / 1_000),
      );
      return NextResponse.json(
        { ok: false, error: GENERIC_ERROR },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
    if (result.status !== "success") {
      return NextResponse.json({ ok: false, error: GENERIC_ERROR }, { status: 401 });
    }

    const response = NextResponse.json({
      ok: true,
      redirectTo: safeReturnTo(typeof body["returnTo"] === "string" ? body["returnTo"] : "/"),
    });
    response.cookies.set(
      SESSION_COOKIE_NAME,
      result.token,
      sessionCookieOptions(result.expiresAt),
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    logLoginFailure("authentication", classifyLoginFailure(error));
    return NextResponse.json(
      { ok: false, error: "Không thể đăng nhập lúc này." },
      { status: 500 },
    );
  }
}
