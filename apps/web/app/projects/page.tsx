import { listProjectsSchema } from "@archrender/projects/schemas";
import type { Metadata } from "next";

import { ProjectsPage } from "@/components/projects-page";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";

export const metadata: Metadata = { title: "Dự án" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requirePageSession(); const raw = await searchParams;
  const parsed = listProjectsSchema.parse({ search: typeof raw.search === "string" ? raw.search : undefined, status: typeof raw.status === "string" ? raw.status : undefined, sort: typeof raw.sort === "string" ? raw.sort : undefined, direction: typeof raw.direction === "string" ? raw.direction : undefined, page: typeof raw.page === "string" ? raw.page : undefined });
  const data = await getProjectService().list(principal, parsed);
  return <ProjectsPage data={data} filters={parsed} />;
}
