import { AiEngineError } from "./errors";
import type { EngineExecutionStatus } from "./gateway-client";
import { EngineGatewayClient } from "./gateway-client";
import type { CompiledWorkflow } from "./workflow-compiler";

export interface EngineSubmission {
  requestId: string;
  jobId: string;
  generation: number;
  workflow: CompiledWorkflow;
}

export interface AiEngineAdapter {
  readonly providerId: string;
  health(): Promise<"READY" | "DEGRADED" | "DISCONNECTED">;
  submit(input: EngineSubmission): Promise<string>;
  status(executionId: string): Promise<EngineExecutionStatus>;
  cancel(executionId: string): Promise<void>;
  readOutput(executionId: string, filename: string, maxBytes: number): Promise<Uint8Array>;
}

export class DisconnectedEngineAdapter implements AiEngineAdapter {
  readonly providerId = "disconnected";
  async health() { return "DISCONNECTED" as const; }
  async submit(): Promise<never> { throw disconnected(); }
  async status(): Promise<never> { throw disconnected(); }
  async cancel(): Promise<never> { throw disconnected(); }
  async readOutput(): Promise<never> { throw disconnected(); }
}

export class PrivateGatewayEngineAdapter implements AiEngineAdapter {
  readonly providerId = "private-comfyui-v4";
  constructor(private readonly client: EngineGatewayClient) {}
  health() { return this.client.health(); }
  submit(input: EngineSubmission) {
    return this.client.submit({ requestId: input.requestId, jobId: input.jobId, generation: input.generation, prompt: input.workflow.prompt });
  }
  status(executionId: string) { return this.client.status(executionId); }
  cancel(executionId: string) { return this.client.cancel(executionId); }
  readOutput(executionId: string, filename: string, maxBytes: number) { return this.client.readOutput(executionId, filename, maxBytes); }
}

function disconnected(): AiEngineError {
  return new AiEngineError("AI_ENGINE_DISCONNECTED", "No AI execution provider is connected.", true);
}
