const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function configuredOrigins(): Set<string> {
  return new Set(
    (process.env["AUTH_TRUSTED_ORIGINS"] ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function effectiveOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const trustProxy = process.env["AUTH_TRUST_PROXY"] === "true";
  const host = trustProxy
    ? request.headers.get("x-forwarded-host")
    : request.headers.get("host");
  const protocol = trustProxy
    ? request.headers.get("x-forwarded-proto")
    : requestUrl.protocol.slice(0, -1);
  if (!host || !protocol || host.includes(",") || protocol.includes(",")) return null;
  if (protocol !== "http" && protocol !== "https") return null;
  return `${protocol}://${host}`;
}

export function isTrustedMutationRequest(request: Request): boolean {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expectedOrigin = effectiveOrigin(request);
  return origin === expectedOrigin || configuredOrigins().has(origin);
}

export function getClientAddress(request: Request): string {
  if (process.env["AUTH_TRUST_PROXY"] !== "true") return "untrusted-proxy";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("cf-connecting-ip") || "unavailable";
}
