import type { Metadata } from "next";
import { WorkflowStudio } from "@/components/workflow-studio";
import { requirePageSession } from "@/lib/auth/session";
export const metadata: Metadata = { title: "Workflow Studio" };
export default async function Page() { await requirePageSession(); return <WorkflowStudio />; }
