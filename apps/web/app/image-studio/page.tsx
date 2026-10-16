import type { Metadata } from "next";
import { ImageStudio } from "@/components/image-studio";
import { getAssetService } from "@/lib/assets/server";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";

export const metadata: Metadata = { title: "AI Image Studio" };
export default async function ImageStudioPage() {
  const principal = await requirePageSession();
  const [projects, assets] = await Promise.all([
    getProjectService().list(principal, { status: "ALL", sort: "name", direction: "asc", page: 1, pageSize: 24 }),
    getAssetService().list(principal, { page: 1, pageSize: 1 }),
  ]);
  return <ImageStudio
    projectOptions={projects.items.map(({ id, name, status }) => ({ id, name, status }))}
    uploadPolicy={assets.policy}
  />;
}
