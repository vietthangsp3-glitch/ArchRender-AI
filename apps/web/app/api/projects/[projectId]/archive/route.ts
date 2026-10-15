import { NextResponse } from "next/server";

import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { projectErrorResponse } from "@/lib/projects/http";
import { getProjectService } from "@/lib/projects/server";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ ok: false, code: "PROJECT_INVALID_ORIGIN" }, { status: 403 });
  }
  const principal = await getRequestSession();
  if (!principal) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const { projectId } = await context.params;
    const project = await getProjectService().archive(principal, projectId, await request.json());
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
