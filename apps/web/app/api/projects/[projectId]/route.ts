import { NextResponse } from "next/server";

import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { projectErrorResponse } from "@/lib/projects/http";
import { getProjectService } from "@/lib/projects/server";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const principal = await getRequestSession();
  if (!principal) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const { projectId } = await context.params;
    const project = await getProjectService().get(principal, projectId);
    return NextResponse.json({ ok: true, project }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ ok: false, code: "PROJECT_INVALID_ORIGIN" }, { status: 403 });
  }
  const principal = await getRequestSession();
  if (!principal) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const { projectId } = await context.params;
    const project = await getProjectService().update(principal, projectId, await request.json());
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
