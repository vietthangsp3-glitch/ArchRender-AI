"use client";

import { CircleOff, Cpu, LockKeyhole, Server, ShieldCheck, Zap } from "lucide-react";

import { Badge, Card, SectionTitle } from "./ui";
import { PageHeader } from "./page-header";

const checks = [
  ["GPU provider", "DISCONNECTED"],
  ["AI Engine gateway", "NOT CONFIGURED"],
  ["Verified model manifest", "PENDING OPERATOR VERIFICATION"],
  ["ComfyUI runtime", "NOT STARTED"],
] as const;

export function GpuPage() {
  return <div className="space-y-5">
    <PageHeader title="Quản lý GPU" description="Control plane Phase 3. Mặc định an toàn: không nhà cung cấp GPU nào được kết nối và không có giá hoặc trạng thái mô phỏng." />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="p-4"><Cpu size={18} className="text-slate-500" /><p className="mt-3 text-xs text-slate-500">GPU hiện tại</p><p className="mt-1 text-lg font-semibold">Chưa cấp</p></Card>
      <Card className="p-4"><Zap size={18} className="text-slate-500" /><p className="mt-3 text-xs text-slate-500">VRAM</p><p className="mt-1 text-lg font-semibold">—</p></Card>
      <Card className="p-4"><Server size={18} className="text-slate-500" /><p className="mt-3 text-xs text-slate-500">Provider</p><p className="mt-1 text-lg font-semibold">Disconnected</p></Card>
      <Card className="p-4"><ShieldCheck size={18} className="text-slate-500" /><p className="mt-3 text-xs text-slate-500">Chi phí</p><p className="mt-1 text-lg font-semibold">Không phát sinh</p></Card>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5"><SectionTitle title="Trạng thái AI Engine" /><div className="space-y-3">{checks.map(([label, status]) => <div key={label} className="flex items-center justify-between gap-4 rounded-lg border border-[#263648] p-3 text-xs"><span className="text-slate-300">{label}</span><Badge tone="neutral">{status}</Badge></div>)}</div></Card>
      <Card className="p-5"><SectionTitle title="Biên an toàn" /><div className="flex gap-3 rounded-lg border border-blue-400/20 bg-blue-400/5 p-4 text-xs leading-5 text-slate-300"><LockKeyhole size={19} className="mt-0.5 shrink-0 text-blue-300" /><p>ComfyUI không được public trực tiếp. Worker dùng service credential riêng, model phải có source/license/SHA-256 đã xác minh, và GPU chỉ được bật sau checkpoint ngân sách của operator.</p></div><div className="mt-4 flex gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-5 text-amber-100"><CircleOff size={19} className="mt-0.5 shrink-0" /><p>Provision/start/stop GPU chưa được bật trong UI. Các thao tác trả phí phải qua provider adapter và approval riêng; trang này không mô phỏng thành công.</p></div></Card>
    </div>
  </div>;
}
