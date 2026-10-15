import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie";
import { proxy } from "./proxy";

describe("route proxy", () => {
  it("redirects unauthenticated pages without accepting external return targets", () => {
    const response = proxy(new NextRequest("https://studio.example/projects?view=recent"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://studio.example/login?returnTo=%2Fprojects%3Fview%3Drecent",
    );
  });

  it("rejects protected APIs without a session cookie", async () => {
    const response = proxy(new NextRequest("https://studio.example/api/projects"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("performs only an optimistic cookie-presence check", () => {
    const request = new NextRequest("https://studio.example/projects", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-token` },
    });
    expect(proxy(request).status).toBe(200);
  });
});
