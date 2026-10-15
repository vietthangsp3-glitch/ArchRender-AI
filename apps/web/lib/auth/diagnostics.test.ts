import { describe, expect, it, vi } from "vitest";

import { classifyLoginFailure, logLoginFailure } from "./diagnostics";

describe("login diagnostics", () => {
  it("maps configuration and database failures to safe codes", () => {
    expect(
      classifyLoginFailure(
        new Error("AUTH_CONTEXT_SECRET must contain at least 32 bytes."),
      ),
    ).toBe("AUTH_CONTEXT_SECRET_INVALID");

    const databaseError = Object.assign(new Error("sensitive database details"), {
      code: "P2021",
    });
    expect(classifyLoginFailure(databaseError)).toBe("AUTH_DATABASE_P2021");
    expect(classifyLoginFailure(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(
      "AUTH_RUNTIME_EACCES",
    );
  });

  it("does not log the original error or its message", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveError = new Error("must never appear in logs");

    logLoginFailure("authentication", classifyLoginFailure(sensitiveError));

    expect(errorSpy).toHaveBeenCalledWith(
      "[auth.login] request failed step=authentication code=AUTH_UNEXPECTED_ERROR",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveError.message);
    errorSpy.mockRestore();
  });
});
