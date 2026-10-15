import { getRequestSession } from "@/lib/auth/session";
import { assetErrorResponse, privateJson } from "@/lib/assets/http";
import { getAssetService } from "@/lib/assets/server";

export async function GET(request: Request) {
  const principal = await getRequestSession();
  if (!principal) return privateJson({ ok: false }, { status: 401 });
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const result = await getAssetService().list(principal, query);
    return privateJson({ ok: true, result });
  } catch (error) {
    return assetErrorResponse(error);
  }
}
