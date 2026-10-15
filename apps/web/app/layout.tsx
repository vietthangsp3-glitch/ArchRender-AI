import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: {
    default: "ArchRender AI",
    template: "%s · ArchRender AI",
  },
  description: "Không gian diễn họa kiến trúc bằng AI dành cho quy trình chuyên nghiệp.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
