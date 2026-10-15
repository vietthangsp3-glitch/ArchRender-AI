import { AuthorizationError } from "@archrender/auth";
import { ProjectApplicationError } from "@archrender/projects";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function projectErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { ok: false, code: "PROJECT_VALIDATION", issues: error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ ok: false, code: "PROJECT_FORBIDDEN" }, { status: 403 });
  }
  if (error instanceof ProjectApplicationError) {
    const status =
      error.code === "PROJECT_NOT_FOUND"
        ? 404
        : error.code === "PROJECT_CONFLICT"
          ? 409
          : 422;
    return NextResponse.json({ ok: false, code: error.code }, { status });
  }
  console.error("[projects.api] request failed code=PROJECT_UNEXPECTED_ERROR");
  return NextResponse.json({ ok: false, code: "PROJECT_UNEXPECTED_ERROR" }, { status: 500 });
}
