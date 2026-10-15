import { assetErrorResponse, privateJson } from "@/lib/assets/http";
import { getAssetService } from "@/lib/assets/server";
import { getRequestSession } from "@/lib/auth/session";

type Context = { params: Promise<{ assetId: string }> };

export async function GET(_request: Request, context: Context) {
  const principal = await getRequestSession();
  if (!principal) return privateJson({ ok: false }, { status: 401 });
  try {
    const { assetId } = await context.params;
    const result = await getAssetService().createReadUrl(principal, assetId);
    return privateJson({ ok: true, result });
  } catch (error) {
    return assetErrorResponse(error);
  }
}
