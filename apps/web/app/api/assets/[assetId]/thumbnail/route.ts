import { getRequestSession } from "@/lib/auth/session";
import { assetErrorResponse, privateJson } from "@/lib/assets/http";
import { getThumbnailService } from "@/lib/assets/server";

type Context = { params: Promise<{ assetId: string }> };
const contractVersion = "2d-d-final-v1";

function versioned(response: Response) {
  response.headers.set("x-archrender-storage-contract", contractVersion);
  return response;
}

export async function GET(request: Request, context: Context) {
  const principal = await getRequestSession();
  if (!principal) return versioned(privateJson({ ok: false }, { status: 401 }));
  try {
    const variantValue = new URL(request.url).searchParams.get("variant") ?? "grid";
    if (variantValue !== "grid" && variantValue !== "detail") {
      return versioned(privateJson({ ok: false, code: "ASSET_INVALID_INPUT" }, { status: 400 }));
    }
    const { assetId } = await context.params;
    const result = await getThumbnailService().createReadUrl(principal, assetId, variantValue);
    return versioned(privateJson({ ok: true, result }));
  } catch (error) {
    return versioned(assetErrorResponse(error));
  }
}
