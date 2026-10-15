import { getRequestSession } from "@/lib/auth/session";
import { isTrustedMutationRequest } from "@/lib/auth/request-security";
import { assetErrorResponse, privateJson } from "@/lib/assets/http";
import { getAssetService } from "@/lib/assets/server";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/assets/[assetId]">,
) {
  const principal = await getRequestSession();
  if (!principal) return privateJson({ ok: false }, { status: 401 });
  try {
    const { assetId } = await params;
    const asset = await getAssetService().get(principal, assetId);
    return privateJson({ ok: true, asset });
  } catch (error) {
    return assetErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: RouteContext<"/api/assets/[assetId]">,
) {
  if (!isTrustedMutationRequest(request)) {
    return privateJson({ ok: false, code: "ASSET_INVALID_ORIGIN" }, { status: 403 });
  }
  const principal = await getRequestSession();
  if (!principal) return privateJson({ ok: false }, { status: 401 });
  try {
    const { assetId } = await params;
    const result = await getAssetService().requestDeletion(principal, assetId);
    return privateJson({ ok: true, result });
  } catch (error) {
    return assetErrorResponse(error);
  }
}
