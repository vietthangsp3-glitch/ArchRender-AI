import { afterEach, describe, expect, it, vi } from "vitest";

import { getClientAddress, isTrustedMutationRequest } from "./request-security";

afterEach(() => vi.unstubAllEnvs());

describe("mutation request security", () => {
  it("accepts same-origin mutations", () => {
    const request = new Request("https://studio.example/api/auth/logout", {
      method: "POST",
      headers: { host: "studio.example", origin: "https://studio.example" },
    });
    expect(isTrustedMutationRequest(request)).toBe(true);
  });

  it("rejects missing or cross-site origins", () => {
    const missing = new Request("https://studio.example/api/auth/logout", {
      method: "POST",
      headers: { host: "studio.example" },
    });
    const crossSite = new Request("https://studio.example/api/auth/logout", {
      method: "POST",
      headers: { host: "studio.example", origin: "https://evil.example" },
    });
    expect(isTrustedMutationRequest(missing)).toBe(false);
    expect(isTrustedMutationRequest(crossSite)).toBe(false);
  });

  it("only trusts forwarded client context when explicitly configured", () => {
    const request = new Request("https://internal/api/auth/login", {
      method: "POST",
      headers: {
        host: "internal",
        origin: "https://studio.example",
        "x-forwarded-host": "studio.example",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.10, 10.0.0.2",
      },
    });
    expect(isTrustedMutationRequest(request)).toBe(false);
    expect(getClientAddress(request)).toBe("untrusted-proxy");
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    expect(isTrustedMutationRequest(request)).toBe(true);
    expect(getClientAddress(request)).toBe("203.0.113.10");
  });

  it("accepts the exact Vercel staging origin behind the trusted proxy", () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    vi.stubEnv("AUTH_TRUSTED_ORIGINS", "https://arch-render-ai.vercel.app");
    const request = new Request("http://internal/api/assets/uploads", {
      method: "POST",
      headers: {
        host: "internal",
        origin: "https://arch-render-ai.vercel.app",
        "x-forwarded-host": "arch-render-ai.vercel.app",
        "x-forwarded-proto": "https",
      },
    });
    expect(isTrustedMutationRequest(request)).toBe(true);
  });
});
