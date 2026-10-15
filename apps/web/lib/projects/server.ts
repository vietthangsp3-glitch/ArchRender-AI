import "server-only";

import { getDatabaseClient } from "@archrender/database";
import { ProjectService } from "@archrender/projects";

let projectService: ProjectService | undefined;

export function getProjectService(): ProjectService {
  projectService ??= new ProjectService(getDatabaseClient());
  return projectService;
}
