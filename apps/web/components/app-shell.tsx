"use client";

import { APP_NAME } from "@archrender/config";
import { cn } from "@archrender/ui";
import { Bell, ChevronDown, CircleHelp, LogOut, Menu, Search, Sparkles, X, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { navigation, quickTools } from "@/lib/mock-data";
import { Badge, Button, DemoStrip } from "./ui";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-3 px-4 py-4 lg:px-5">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-amber-300 via-amber-500 to-orange-700 text-slate-950 shadow-[0_8px_24px_rgba(245,158,11,.18)]"><Sparkles size={19} /></div>
      <div>
        <div className="flex items-center gap-2 text-base font-semibold text-white">{APP_NAME}<Badge tone="blue">PRO</Badge></div>
        <div className="mt-0.5 text-[10px] text-slate-500">AI Architecture Visualization</div>
      </div>
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col bg-[var(--sidebar)]">
      <Logo />
      <div className="mx-4 border-t border-white/[0.06]" />
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Điều hướng chính">
        <div className="space-y-1">
          {navigation.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} {...(onNavigate ? { onClick: onNavigate } : {})} className={cn("group flex min-h-10 items-center gap-3 rounded-lg px-3 text-[13px] transition", active ? "bg-gradient-to-r from-[#31455f] to-[#223348] text-[#8bb6ff] shadow-[inset_2px_0_0_#6c79ff]" : "text-slate-300 hover:bg-white/[0.045] hover:text-white")}>
                <Icon size={17} strokeWidth={1.8} className={active ? "text-[#79a8ff]" : "text-slate-400 group-hover:text-slate-200"} />
                {item.label}
              </Link>
            );
          })}
        </div>
        <div className="my-4 border-t border-white/[0.06]" />
        <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">Công cụ nhanh</div>
        <div className="space-y-1">
          {quickTools.map(({ label, icon: Icon }) => (
            <button key={label} onClick={() => window.alert(`${label}: tính năng sẽ kết nối AI Engine ở Phase 3.`)} className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] text-slate-300 transition hover:bg-white/[0.045] hover:text-white">
              <Icon size={17} className="text-slate-400" /> {label}
            </button>
          ))}
        </div>
      </nav>
      <div className="m-4 rounded-xl border border-[#233246] bg-[#0a121a] p-3.5">
        <div className="flex items-center justify-between text-xs text-slate-300"><span>Dung lượng lưu trữ</span><span>Demo</span></div>
        <div className="mt-2 text-sm font-semibold">120 GB <span className="font-normal text-slate-500">/ 500 GB</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#1e2b3a]"><div className="h-full w-[24%] rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" /></div>
        <Button className="mt-3 w-full text-xs" onClick={() => window.alert("Gói dung lượng là dữ liệu Demo trong Phase 1.")}>Nâng cấp gói</Button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [user, setUser] = useState<{ displayName: string | null; email: string }>();

  useEffect(() => {
    if (pathname === "/login") return;
    let active = true;
    const refreshSession = async () => {
      const response = await fetch("/api/auth/session", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) {
        router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
        return;
      }
      const body = (await response.json()) as {
        user?: { displayName: string | null; email: string };
      };
      if (active && body.user) setUser(body.user);
    };
    void refreshSession();
    const interval = window.setInterval(refreshSession, 5 * 60 * 1_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pathname, router]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  if (pathname === "/login") return <>{children}</>;

  const accountLabel = user?.displayName || user?.email || "Tài khoản";
  const initial = accountLabel.slice(0, 1).toUpperCase();
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[242px] border-r border-white/[0.06] lg:block"><Sidebar /></aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button aria-label="Đóng điều hướng" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-[286px] max-w-[86vw] border-r border-white/10 shadow-2xl"><Sidebar onNavigate={() => setMobileOpen(false)} /><button className="absolute right-3 top-4 rounded-lg p-2 text-slate-300 hover:bg-white/10" onClick={() => setMobileOpen(false)}><X size={18} /></button></aside>
        </div>
      ) : null}
      <div className="lg:pl-[242px]">
        <header className="sticky top-0 z-30 flex h-[66px] items-center gap-3 border-b border-white/[0.06] bg-[#091018]/90 px-4 backdrop-blur-xl lg:px-6">
          <button className="rounded-lg p-2 text-slate-300 hover:bg-white/5 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Mở điều hướng"><Menu size={20} /></button>
          <div className="relative hidden w-full max-w-[520px] sm:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={17} />
            <input className="field h-10 pl-10 pr-4 text-xs" placeholder="Tìm dự án, ảnh, video..." aria-label="Tìm kiếm toàn cục" />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button className="hidden items-center gap-3 rounded-xl border border-[#223043] bg-[#0c151e] px-3 py-2 text-left transition hover:border-[#34475d] md:flex" onClick={() => window.alert("GPU hiện tại là trạng thái Demo. Không có API provider nào được gọi.")}>
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-lime-400/10 text-lime-400"><Zap size={16} /></div>
              <div><div className="text-xs font-semibold text-slate-100">RTX 4090 <span className="ml-1 text-[10px] font-normal text-emerald-400">● Demo</span></div><div className="mt-0.5 text-[10px] text-slate-500">0.42 USD/giờ</div></div>
            </button>
            <button className="relative rounded-lg p-2.5 text-slate-400 hover:bg-white/5 hover:text-white" aria-label="Thông báo"><Bell size={18} /><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-rose-500" /></button>
            <button className="hidden rounded-lg p-2.5 text-slate-400 hover:bg-white/5 sm:block" aria-label="Trợ giúp"><CircleHelp size={18} /></button>
            <div className="relative">
            <button className="flex items-center gap-2 rounded-xl p-1.5 pr-2 hover:bg-white/5" onClick={() => setAccountOpen((open) => !open)} aria-expanded={accountOpen}>
              <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-xs font-semibold">{initial}</span>
              <span className="hidden max-w-40 text-left md:block"><span className="block truncate text-xs font-medium">{accountLabel}</span><span className="block text-[10px] text-blue-300">OWNER</span></span>
              <ChevronDown size={14} className="hidden text-slate-500 md:block" />
            </button>
            {accountOpen ? <div className="absolute right-0 top-12 w-48 rounded-xl border border-white/10 bg-[#101923] p-1.5 shadow-2xl"><button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/5 hover:text-white" onClick={logout}><LogOut size={15} />Đăng xuất</button></div> : null}
            </div>
          </div>
        </header>
        <DemoStrip />
        <main className="min-h-[calc(100vh-99px)] p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
