import type { Metadata } from "next";
import { JobsPage } from "@/components/jobs-page";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";
export const metadata: Metadata = { title: "Lịch sử xử lý" };
export default async function Page() { const principal = await requirePageSession(); const projects = await getProjectService().list(principal, { status: "ALL", sort: "name", direction: "asc", page: 1, pageSize: 50 }); return <JobsPage projectOptions={projects.items.map(({ id, name }) => ({ id, name }))} />; }
