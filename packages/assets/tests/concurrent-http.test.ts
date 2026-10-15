import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatSafeConcurrentOutcome,
  settleConcurrentHttpRequests,
} from "../scripts/concurrent-http.js";

const servers: Server[] = [];

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_SERVER_ADDRESS_FAILED");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("focused concurrent acceptance HTTP client", () => {
  it("captures legitimate 200/409 concurrent outcomes from a local HTTP server", async () => {
    let requests = 0;
    const origin = await localServer((_request, response) => {
      requests += 1;
      const status = requests === 1 ? 200 : 409;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { ok: true } : { code: "ASSET_VERIFICATION_IN_PROGRESS" }));
    });
    const operation = async (signal: AbortSignal) => {
      const response = await fetch(`${origin}/complete`, { method: "POST", signal });
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, code: body["code"] };
    };

    const outcomes = await settleConcurrentHttpRequests([operation, operation], 2_000);

    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "HTTP", status: 200 }),
      expect.objectContaining({ kind: "HTTP", status: 409, safeCode: "ASSET_VERIFICATION_IN_PROGRESS" }),
    ]));
  });

  it("classifies a transport rejection without inventing an HTTP conflict", async () => {
    const origin = await localServer((request) => request.socket.destroy());
    const operation = async (signal: AbortSignal) => {
      const response = await fetch(`${origin}/complete`, { method: "POST", signal });
      return { status: response.status };
    };

    const outcomes = await settleConcurrentHttpRequests([operation, operation], 2_000);

    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "REJECTION", category: "TRANSPORT_UNKNOWN", status: null }),
      expect.objectContaining({ kind: "REJECTION", category: "TRANSPORT_UNKNOWN", status: null }),
    ]);
    expect(outcomes.map(formatSafeConcurrentOutcome).join(" ")).not.toMatch(/https?:|cookie|header|body/i);
  });

  it("distinguishes timeout and malformed client responses", async () => {
    const origin = await localServer(() => undefined);
    const timeoutOperation = async (signal: AbortSignal) => {
      const response = await fetch(`${origin}/complete`, { signal });
      return { status: response.status };
    };

    const [timedOut, malformed] = await settleConcurrentHttpRequests([
      timeoutOperation,
      async () => ({ status: Number.NaN }),
    ], 100);

    expect(timedOut).toMatchObject({ kind: "REJECTION", category: "TIMEOUT", status: null });
    expect(malformed).toMatchObject({ kind: "REJECTION", category: "MALFORMED_RESPONSE", status: null });
  });
});
