import { z } from "zod";

import { AiEngineError } from "./errors";
import type { ComfyPrompt } from "./workflow-compiler";

const submitResponseSchema = z.object({ executionId: z.string().uuid() }).strict();
const statusResponseSchema = z.object({
  executionId: z.string().uuid(),
  state: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),
  progress: z.number().min(0).max(100),
  outputs: z.array(z.object({ filename: z.string(), contentType: z.string(), byteSize: z.number().int().positive() }).strict()).max(8),
  errorCode: z.string().regex(/^[A-Z0-9_]{1,128}$/).nullable(),
}).strict();

export type EngineExecutionStatus = z.infer<typeof statusResponseSchema>;

export interface EngineGatewayClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class EngineGatewayClient {
  private readonly baseUrl: URL;
  private readonly request: typeof fetch;

  constructor(private readonly options: EngineGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!new Set(["https:", "http:"]).has(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Invalid engine gateway URL.");
    }
    if (this.baseUrl.protocol === "http:" && !new Set(["127.0.0.1", "localhost", "ai-gateway"]).has(this.baseUrl.hostname)) {
      throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Remote engine gateway must use HTTPS.");
    }
    if (options.serviceToken.length < 32) throw new AiEngineError("AI_ENGINE_AUTH_FAILED", "Worker credential is invalid.");
    this.request = options.fetch ?? fetch;
  }

  async submit(input: { requestId: string; jobId: string; generation: number; prompt: ComfyPrompt }): Promise<string> {
    const response = await this.call("/v1/executions", "POST", input);
    return submitResponseSchema.parse(response).executionId;
  }

  async status(executionId: string): Promise<EngineExecutionStatus> {
    return statusResponseSchema.parse(await this.call(`/v1/executions/${encodeURIComponent(executionId)}`, "GET"));
  }

  async cancel(executionId: string): Promise<void> {
    await this.call(`/v1/executions/${encodeURIComponent(executionId)}/cancel`, "POST", {});
  }

  async readOutput(executionId: string, filename: string, maxBytes: number): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(filename) || !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Invalid output read request.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.request(
        new URL(`/v1/executions/${encodeURIComponent(executionId)}/outputs/${encodeURIComponent(filename)}`, this.baseUrl),
        { headers: { authorization: `Bearer ${this.options.serviceToken}` }, signal: controller.signal, redirect: "error" },
      );
      if (!response.ok) throw new AiEngineError("AI_ENGINE_PROVIDER_REJECTED", "Output read was rejected.", response.status >= 500);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > maxBytes) {
        throw new AiEngineError("AI_ENGINE_OUTPUT_INVALID", "Output size is invalid.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== declaredLength || bytes.byteLength > maxBytes) {
        throw new AiEngineError("AI_ENGINE_OUTPUT_INVALID", "Output length changed while reading.");
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  async stageInput(workspaceId: string, filename: string, bytes: Uint8Array, checksumSha256: string): Promise<string> {
    if (!/^[a-f0-9]{32,80}$/.test(workspaceId) || !/^[A-Za-z0-9_.-]{1,180}$/.test(filename) || !/^[a-f0-9]{64}$/.test(checksumSha256)) {
      throw new AiEngineError("AI_ENGINE_INVALID_INPUT", "Invalid staged input identity.");
    }
    const response = await this.request(new URL(`/v1/workspaces/${workspaceId}/inputs/${encodeURIComponent(filename)}`, this.baseUrl), {
      method: "PUT",
      headers: { authorization: `Bearer ${this.options.serviceToken}`, "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), "x-content-sha256": checksumSha256 },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(this.options.timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new AiEngineError("AI_ENGINE_PROVIDER_REJECTED", "Input staging was rejected.", response.status >= 500);
    return z.object({ filename: z.string().regex(/^[A-Za-z0-9_.-]{1,220}$/) }).parse(await response.json()).filename;
  }

  async deleteInput(workspaceId: string, filename: string, checksumSha256: string): Promise<void> {
    if (!/^[a-f0-9]{32,80}$/.test(workspaceId) || !/^[A-Za-z0-9_.-]{1,180}$/.test(filename) || !/^[a-f0-9]{64}$/.test(checksumSha256)) return;
    const response = await this.request(new URL(`/v1/workspaces/${workspaceId}/inputs/${encodeURIComponent(filename)}`, this.baseUrl), {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.options.serviceToken}`, "x-content-sha256": checksumSha256 },
      signal: AbortSignal.timeout(this.options.timeoutMs),
      redirect: "error",
    });
    if (!response.ok && response.status !== 404) throw new AiEngineError("AI_ENGINE_PROVIDER_REJECTED", "Input cleanup was rejected.", response.status >= 500);
  }

  async health(): Promise<"READY" | "DEGRADED"> {
    const response = z.object({ status: z.enum(["READY", "DEGRADED"]) }).parse(await this.call("/healthz", "GET"));
    return response.status;
  }

  private async call(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.request(new URL(path, this.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.options.serviceToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) throw new AiEngineError("AI_ENGINE_AUTH_FAILED", "Engine authentication failed.");
      if (!response.ok) throw new AiEngineError("AI_ENGINE_PROVIDER_REJECTED", "Engine request was rejected.", response.status >= 500);
      return await response.json();
    } catch (error) {
      if (error instanceof AiEngineError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new AiEngineError("AI_ENGINE_TIMEOUT", "Engine request timed out.", true);
      throw new AiEngineError("AI_ENGINE_TRANSPORT", "Engine transport failed.", true, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
