import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { jobErrorResponse, jobJson, readJobJson } from "@/lib/jobs/http";
import { getWorkflowService } from "@/lib/jobs/server";

type Context = { params: Promise<{ workflowId: string }> };
export async function GET(_request: Request, context: Context) {
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, workflow: await getWorkflowService().get(principal, (await context.params).workflowId) }); }
  catch (error) { return jobErrorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  if (!isTrustedMutationRequest(request)) return jobJson({ ok: false, code: "JOB_INVALID_ORIGIN" }, { status: 403 });
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, workflow: await getWorkflowService().update(principal, (await context.params).workflowId, await readJobJson(request)) }); }
  catch (error) { return jobErrorResponse(error); }
}
