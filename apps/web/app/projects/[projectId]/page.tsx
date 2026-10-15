import { ProjectApplicationError } from "@archrender/projects";
import type { ProjectSummary } from "@archrender/projects/types";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ProjectDetail } from "@/components/project-detail";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";
import { getRenderJobService } from "@/lib/jobs/server";

export const metadata: Metadata = { title: "Chi tiết dự án" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const principal = await requirePageSession(); const { projectId } = await params;
  let project: ProjectSummary;
  try { project = await getProjectService().get(principal, projectId); }
  catch (error) { if (error instanceof ProjectApplicationError && error.code === "PROJECT_NOT_FOUND") notFound(); throw error; }
  const jobSummary = await getRenderJobService().summary(principal, projectId);
  return <ProjectDetail initialProject={project} jobSummary={jobSummary} />;
}
