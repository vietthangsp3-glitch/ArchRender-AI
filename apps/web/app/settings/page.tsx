import type { Metadata } from "next";
import { SettingsPage } from "@/components/settings-page";
import { requirePageSession } from "@/lib/auth/session";
export const metadata: Metadata = { title: "Cài đặt" };
export default async function Page() { await requirePageSession(); return <SettingsPage />; }
