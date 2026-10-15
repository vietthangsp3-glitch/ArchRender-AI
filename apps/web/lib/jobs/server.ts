import "server-only";

import { getDatabaseClient } from "@archrender/database";
import { RenderJobService, WorkflowService } from "@archrender/jobs";

let renderJobService: RenderJobService | undefined;
let workflowService: WorkflowService | undefined;

export function getRenderJobService() {
  renderJobService ??= new RenderJobService(getDatabaseClient());
  return renderJobService;
}

export function getWorkflowService() {
  workflowService ??= new WorkflowService(getDatabaseClient());
  return workflowService;
}
