import { NextResponse } from "next/server";

import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { projectErrorResponse } from "@/lib/projects/http";
import { getProjectService } from "@/lib/projects/server";

export async function GET(request: Request) {
  const principal = await getRequestSession();
  if (!principal) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const result = await getProjectService().list(principal, query);
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ ok: false, code: "PROJECT_INVALID_ORIGIN" }, { status: 403 });
  }
  const principal = await getRequestSession();
  if (!principal) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const project = await getProjectService().create(principal, await request.json());
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
