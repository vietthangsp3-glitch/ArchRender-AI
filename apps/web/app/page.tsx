import { Dashboard } from "@/components/dashboard";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";
import { getRenderJobService } from "@/lib/jobs/server";
export default async function HomePage() { const principal = await requirePageSession(); const [projects, jobSummary] = await Promise.all([getProjectService().list(principal, { status: "ALL", page: 1, pageSize: 1 }), getRenderJobService().summary(principal)]); return <Dashboard projectCount={projects.total} jobSummary={jobSummary} />; }
