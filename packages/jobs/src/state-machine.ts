import type { RenderJobStatus } from "@archrender/database";

const transitions: Record<RenderJobStatus, readonly RenderJobStatus[]> = {
  CREATED: ["QUEUED", "CANCELLED"],
  UPLOADING: ["QUEUED", "CANCELLED", "FAILED"],
  QUEUED: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED", "FAILED", "CANCELLED"],
  PROVISIONING: ["RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED", "FAILED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "RETRY_SCHEDULED"],
  CANCEL_REQUESTED: ["CANCELLED", "FAILED"],
  RETRY_SCHEDULED: ["CLAIMED", "CANCELLED", "FAILED"],
  SUCCEEDED: [],
  FAILED: ["RETRY_SCHEDULED"],
  CANCELLED: [],
};

export function canTransition(from: RenderJobStatus, to: RenderJobStatus) {
  return transitions[from].includes(to);
}

export function isTerminal(status: RenderJobStatus) {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}
