import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { jobErrorResponse, jobJson } from "@/lib/jobs/http";
import { getRenderJobService } from "@/lib/jobs/server";

type Context = { params: Promise<{ jobId: string }> };
export async function POST(request: Request, context: Context) {
  if (!isTrustedMutationRequest(request)) return jobJson({ ok: false, code: "JOB_INVALID_ORIGIN" }, { status: 403 });
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, job: await getRenderJobService().retry(principal, (await context.params).jobId) }); }
  catch (error) { return jobErrorResponse(error); }
}
