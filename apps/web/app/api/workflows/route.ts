import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { jobErrorResponse, jobJson, readJobJson } from "@/lib/jobs/http";
import { getWorkflowService } from "@/lib/jobs/server";

export async function GET(request: Request) {
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, workflows: await getWorkflowService().list(principal, Object.fromEntries(new URL(request.url).searchParams)) }); }
  catch (error) { return jobErrorResponse(error); }
}
export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return jobJson({ ok: false, code: "JOB_INVALID_ORIGIN" }, { status: 403 });
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, workflow: await getWorkflowService().create(principal, await readJobJson(request)) }, { status: 201 }); }
  catch (error) { return jobErrorResponse(error); }
}
