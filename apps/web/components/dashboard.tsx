"use client";

import { CheckCircle2, Clock3, FolderKanban, Image as ImageIcon, ListChecks, Plus, Video, XCircle } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, SectionTitle } from "./ui";
import { PageHeader } from "./page-header";

type Summary = { total: number; queued: number; running: number; succeeded: number; failed: number; recent: Array<{ id: string; status: string; type: string; progress: number; createdAt: Date | string; project: { name: string }; workflowVersion: { version: number; preset: { name: string } } | null }> };
export function Dashboard({ projectCount, jobSummary }: { projectCount: number; jobSummary: Summary }) {
  const stats = [
    { label: "Dự án", value: projectCount, icon: FolderKanban, color: "text-blue-300 bg-blue-400/10" },
    { label: "Tổng jobs", value: jobSummary.total, icon: ListChecks, color: "text-violet-300 bg-violet-400/10" },
    { label: "Đang chờ", value: jobSummary.queued, icon: Clock3, color: "text-amber-300 bg-amber-400/10" },
    { label: "Đang xử lý", value: jobSummary.running, icon: ImageIcon, color: "text-cyan-300 bg-cyan-400/10" },
    { label: "Thành công", value: jobSummary.succeeded, icon: CheckCircle2, color: "text-emerald-300 bg-emerald-400/10" },
    { label: "Thất bại", value: jobSummary.failed, icon: XCircle, color: "text-red-300 bg-red-400/10" },
  ];
  return <div className="space-y-5">
    <PageHeader title="ArchRender Dashboard" description="Số liệu owner-scoped từ PostgreSQL; không hiển thị GPU hoặc chi phí giả." actions={<Link href="/image-studio"><Button variant="primary"><Plus size={16} /> Render ảnh mới</Button></Link>} />
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{stats.map(({ label, value, icon: Icon, color }) => <Card key={label} className="p-4"><div className={`grid h-9 w-9 place-items-center rounded-lg ${color}`}><Icon size={18} /></div><div className="mt-4 text-2xl font-semibold">{value}</div><div className="mt-1 text-xs text-slate-400">{label}</div></Card>)}</div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="p-4"><SectionTitle title="Jobs gần đây" action={<Link href="/jobs" className="text-xs text-blue-300">Xem tất cả →</Link>} />{jobSummary.recent.length ? <div className="space-y-2">{jobSummary.recent.map((job) => <Link key={job.id} href={`/jobs?job=${job.id}`} className="flex items-center gap-3 rounded-lg border border-[#253548] bg-[#0c151e] p-3"><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{job.project.name}</p><p className="mt-1 truncate text-[10px] text-slate-500">{job.workflowVersion ? `${job.workflowVersion.preset.name} · v${job.workflowVersion.version}` : "Legacy workflow"} · {job.type}</p></div><span className="text-xs text-slate-500">{job.progress}%</span><Badge>{job.status}</Badge></Link>)}</div> : <p className="rounded-lg border border-dashed border-[#33465a] p-6 text-center text-sm text-slate-500">Chưa có Render Job.</p>}</Card>
      <Card className="h-fit p-4"><SectionTitle title="Thao tác nhanh" /><div className="grid gap-2"><Link href="/image-studio"><Button className="w-full justify-start"><ImageIcon size={16} /> Render ảnh</Button></Link><Link href="/video-studio"><Button className="w-full justify-start"><Video size={16} /> Tạo video</Button></Link><Link href="/workflow-studio"><Button className="w-full justify-start"><ListChecks size={16} /> Workflow Studio</Button></Link><Link href="/projects"><Button className="w-full justify-start"><FolderKanban size={16} /> Projects</Button></Link></div></Card>
    </div>
  </div>;
}
