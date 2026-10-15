import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { jobErrorResponse, jobJson } from "@/lib/jobs/http";
import { getWorkflowService } from "@/lib/jobs/server";

type Context = { params: Promise<{ workflowId: string }> };
export async function POST(request: Request, context: Context) {
  if (!isTrustedMutationRequest(request)) return jobJson({ ok: false, code: "JOB_INVALID_ORIGIN" }, { status: 403 });
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, version: await getWorkflowService().publish(principal, (await context.params).workflowId) }); }
  catch (error) { return jobErrorResponse(error); }
}
