import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck, Sparkles } from "lucide-react";

import { safeReturnTo } from "@archrender/auth";
import { LoginForm } from "@/components/login-form";
import { getRequestSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Đăng nhập" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const session = await getRequestSession();
  if (session) redirect("/");
  const { returnTo } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[430px]">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-amber-300 via-amber-500 to-orange-700 text-slate-950 shadow-[0_8px_30px_rgba(245,158,11,.2)]">
            <Sparkles size={21} />
          </div>
          <div>
            <p className="text-lg font-semibold text-white">ArchRender AI</p>
            <p className="text-[11px] text-slate-500">Private Studio Access</p>
          </div>
        </div>
        <section className="panel p-6 shadow-2xl sm:p-7">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-400/10 text-blue-300">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-[-0.02em] text-white">Đăng nhập Studio</h1>
              <p className="mt-1 text-sm leading-6 text-slate-400">
                Khu vực riêng dành cho tài khoản đã được quản trị viên cấp quyền.
              </p>
            </div>
          </div>
          <LoginForm returnTo={safeReturnTo(returnTo)} />
          <p className="mt-5 border-t border-white/[0.06] pt-4 text-center text-[11px] leading-5 text-slate-500">
            Không hỗ trợ đăng ký công khai. Liên hệ chủ hệ thống nếu bạn cần quyền truy cập.
          </p>
        </section>
      </div>
    </main>
  );
}
