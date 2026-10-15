import { beforeEach, describe, expect, it, vi } from "vitest";

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({
  getAuthService: () => ({ login: loginMock }),
}));

import { POST } from "./route";

function loginRequest(body: BodyInit, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost:3000",
      origin,
    },
    body,
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    loginMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("rejects an untrusted origin before authentication", async () => {
    const response = await POST(loginRequest("{}", "http://attacker.invalid"));

    expect(response.status).toBe(403);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON instead of masking it as a server error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(loginRequest("{"));

    expect(response.status).toBe(400);
    expect(loginMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[auth.login] request failed step=request_parse code=AUTH_REQUEST_INVALID_JSON",
    );
    errorSpy.mockRestore();
  });

  it("logs only a safe code when authentication raises a runtime error", async () => {
    const sensitiveMessage = "database endpoint must not be logged";
    loginMock.mockRejectedValue(Object.assign(new Error(sensitiveMessage), { code: "EACCES" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(
      loginRequest(
        JSON.stringify({ email: "probe@example.test", password: "not-a-real-secret" }),
      ),
    );

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      "[auth.login] request failed step=authentication code=AUTH_RUNTIME_EACCES",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveMessage);
    errorSpy.mockRestore();
  });

  it("preserves the generic invalid-credentials response", async () => {
    loginMock.mockResolvedValue({ status: "invalid" });

    const response = await POST(
      loginRequest(
        JSON.stringify({ email: "probe@example.test", password: "not-a-real-secret" }),
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
