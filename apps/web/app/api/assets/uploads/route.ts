import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { assetErrorResponse, privateJson, readBoundedJson } from "@/lib/assets/http";
import { getAssetService } from "@/lib/assets/server";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return privateJson({ ok: false, code: "ASSET_INVALID_ORIGIN" }, { status: 403 });
  }
  const principal = await getRequestSession();
  if (!principal) return privateJson({ ok: false }, { status: 401 });
  try {
    const result = await getAssetService().prepareUpload(principal, await readBoundedJson(request));
    return privateJson({ ok: true, result }, { status: 201 });
  } catch (error) {
    return assetErrorResponse(error);
  }
}
