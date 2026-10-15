import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { jobErrorResponse, jobJson, readJobJson } from "@/lib/jobs/http";
import { getRenderJobService } from "@/lib/jobs/server";

export async function GET(request: Request) {
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try {
    const result = await getRenderJobService().list(principal, Object.fromEntries(new URL(request.url).searchParams));
    return jobJson({ ok: true, result });
  } catch (error) { return jobErrorResponse(error); }
}

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return jobJson({ ok: false, code: "JOB_INVALID_ORIGIN" }, { status: 403 });
  const principal = await getRequestSession();
  if (!principal) return jobJson({ ok: false }, { status: 401 });
  try {
    const job = await getRenderJobService().submit(principal, await readJobJson(request));
    return jobJson({ ok: true, job }, { status: 201 });
  } catch (error) { return jobErrorResponse(error); }
}
