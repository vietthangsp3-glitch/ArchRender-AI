import type { Metadata } from "next";
import { AssetsPage } from "@/components/assets-page";
import { requirePageSession } from "@/lib/auth/session";
import { getProjectService } from "@/lib/projects/server";
export const metadata: Metadata = { title: "Thư viện tài nguyên" };
export default async function Page() {
  const principal = await requirePageSession();
  const projects = await getProjectService().list(principal, {
    status: "ALL", sort: "name", direction: "asc", page: 1, pageSize: 24,
  });
  return <AssetsPage projectOptions={projects.items.map(({ id, name, status }) => ({ id, name, status }))} />;
}
