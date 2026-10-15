import type { Metadata } from "next";
import { GpuPage } from "@/components/gpu-page";
import { requirePageSession } from "@/lib/auth/session";
export const metadata: Metadata = { title: "Quản lý GPU" };
export default async function Page() { await requirePageSession(); return <GpuPage />; }
