import type { Metadata } from "next";
import { VideoStudio } from "@/components/video-studio";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";
export const metadata: Metadata = { title: "AI Video Studio" };
export default async function Page() { const principal = await requirePageSession(); const result = await getProjectService().list(principal, { status: "ACTIVE", sort: "name", direction: "asc", page: 1, pageSize: 24 }); return <VideoStudio projectOptions={result.items.map(({ id, name }) => ({ id, name }))} />; }
