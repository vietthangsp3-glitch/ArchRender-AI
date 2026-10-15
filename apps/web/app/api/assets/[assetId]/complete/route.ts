import { randomUUID } from "node:crypto";

import { createSafeCompletionDiagnostic, type CompletionTrace } from "@archrender/assets";

import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { assetErrorResponse, privateJson, readBoundedJson } from "@/lib/assets/http";
import { getAssetService } from "@/lib/assets/server";

type Context = { params: Promise<{ assetId: string }> };

export async function POST(request: Request, context: Context) {
  if (!isTrustedMutationRequest(request)) {
    return privateJson({ ok: false, code: "ASSET_INVALID_ORIGIN" }, { status: 403 });
  }
  const principal = await getRequestSession();
  if (!principal) return privateJson({ ok: false }, { status: 401 });
  const suppliedCorrelationId = request.headers.get("x-request-id");
  const correlationId = suppliedCorrelationId && /^[0-9a-f-]{36}$/i.test(suppliedCorrelationId)
    ? suppliedCorrelationId
    : randomUUID();
  const trace: CompletionTrace = { correlationId, phase: "claim" };
  try {
    const { assetId } = await context.params;
    const asset = await getAssetService().completeUpload(
      principal,
      assetId,
      await readBoundedJson(request),
      trace,
    );
    return privateJson({ ok: true, asset }, { headers: { "X-Request-Id": correlationId } });
  } catch (error) {
    const response = assetErrorResponse(error);
    response.headers.set("X-Request-Id", correlationId);
    const diagnostic = createSafeCompletionDiagnostic(trace, error, response.status);
    console.error(`[assets.complete] ${JSON.stringify(diagnostic)}`);
    if (process.env["NODE_ENV"] !== "production") {
      response.headers.set("X-ArchRender-Finalization-Phase", diagnostic.phase);
      response.headers.set("X-ArchRender-Error-Classification", diagnostic.classification);
      response.headers.set("X-ArchRender-Storage-Operation", diagnostic.operation ?? "NONE");
      response.headers.set("X-ArchRender-Storage-Code", diagnostic.storageCode ?? "NONE");
      response.headers.set("X-ArchRender-Provider-Status", diagnostic.providerHttpStatus === null
        ? "NONE"
        : String(diagnostic.providerHttpStatus));
      response.headers.set("X-ArchRender-Application-Status", String(diagnostic.httpStatus));
    }
    return response;
  }
}
