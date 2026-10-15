import type { Metadata } from "next";
import { ImageStudio } from "@/components/image-studio";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";

export const metadata: Metadata = { title: "AI Image Studio" };
export default async function ImageStudioPage() { const principal = await requirePageSession(); const result = await getProjectService().list(principal, { status: "ALL", sort: "name", direction: "asc", page: 1, pageSize: 24 }); return <ImageStudio projectOptions={result.items.map(({ id, name, status }) => ({ id, name, status }))} />; }
