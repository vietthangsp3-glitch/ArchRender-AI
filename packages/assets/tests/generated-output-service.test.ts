import { describe, expect, it } from "vitest";

import { createGeneratedOutputRequestId } from "../src/generated-output-service";

describe("generated output recovery identity", () => {
  it("is stable across worker generations and distinct per output slot", () => {
    const base = { jobId: "5d93ec65-2de8-451c-bbf8-b37854af763c", role: "GENERATED_IMAGE" as const };
    const firstAttempt = createGeneratedOutputRequestId({ ...base, position: 0 });
    const recoveredAttempt = createGeneratedOutputRequestId({ ...base, position: 0 });
    expect(recoveredAttempt).toBe(firstAttempt);
    expect(createGeneratedOutputRequestId({ ...base, position: 1 })).not.toBe(firstAttempt);
  });
});
