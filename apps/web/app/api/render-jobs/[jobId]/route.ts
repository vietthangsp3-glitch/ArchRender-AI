import { getRequestSession } from "@/lib/auth/session";
import { jobErrorResponse, jobJson } from "@/lib/jobs/http";
import { getRenderJobService } from "@/lib/jobs/server";

type Context = { params: Promise<{ jobId: string }> };
export async function GET(_request: Request, context: Context) {
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try { return jobJson({ ok: true, job: await getRenderJobService().get(principal, (await context.params).jobId) }); }
  catch (error) { return jobErrorResponse(error); }
}
