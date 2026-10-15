"use client";

import type { ProjectSummary } from "@archrender/projects/types";
import { Archive, ArrowLeft, Boxes, FolderOpen, Pencil, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Button, Card, Modal, SectionTitle } from "./ui";
import { PageHeader } from "./page-header";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

type JobSummary = { queued: number; running: number; succeeded: number; failed: number; recent: Array<{ id: string; status: string; type: string; progress: number; createdAt: Date | string; workflowVersion: { version: number; preset: { name: string } } | null }> };

export function ProjectDetail({ initialProject, jobSummary }: { initialProject: ProjectSummary; jobSummary: JobSummary }) {
  const router = useRouter();
  const [project, setProject] = useState(initialProject);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function mutate(path: string, body: Record<string, unknown>, method = "POST") {
    setPending(true); setFormError(null);
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = (await response.json()) as { project?: ProjectSummary; code?: string; issues?: Record<string, string[]> };
      if (!response.ok || !payload.project) {
        setFormError(response.status === 409 ? "Dự án đã thay đổi ở nơi khác. Hãy tải lại trang." : payload.issues ? Object.values(payload.issues).flat()[0] ?? "Dữ liệu không hợp lệ." : "Không thể lưu thay đổi.");
        return null;
      }
      setProject(payload.project); router.refresh(); return payload.project;
    } finally { setPending(false); }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const updated = await mutate(`/api/projects/${project.id}`, { name: form.get("name"), description: form.get("description"), expectedUpdatedAt: project.updatedAt }, "PATCH");
    if (updated) { setEditOpen(false); setNotice("Đã cập nhật dự án."); }
  }

  async function transition() {
    const action = project.status === "ACTIVE" ? "archive" : "restore";
    const updated = await mutate(`/api/projects/${project.id}/${action}`, { expectedUpdatedAt: project.updatedAt });
    if (updated) { setConfirmOpen(false); setNotice(action === "archive" ? "Đã lưu trữ dự án." : "Đã khôi phục dự án."); }
  }

  return <div className="space-y-5">
    <PageHeader title={project.name} description={project.description || "Dự án chưa có mô tả."} actions={<><Link href="/projects"><Button><ArrowLeft size={15} /> Danh sách</Button></Link>{project.status === "ACTIVE" ? <Button onClick={() => setEditOpen(true)}><Pencil size={15} /> Chỉnh sửa</Button> : null}<Button variant={project.status === "ACTIVE" ? "danger" : "secondary"} onClick={() => { setFormError(null); setConfirmOpen(true); }}>{project.status === "ACTIVE" ? <Archive size={15} /> : <RotateCcw size={15} />}{project.status === "ACTIVE" ? "Lưu trữ" : "Khôi phục"}</Button></>} />
    {notice ? <div role="status" className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-4 py-3 text-xs text-emerald-200">{notice}</div> : null}
    {project.status === "ARCHIVED" ? <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">Dự án đang được lưu trữ và chỉ có thể xem. Khôi phục trước khi chỉnh sửa.</div> : null}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
      <Card className="p-5"><SectionTitle title="Thông tin dự án" /><dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-xs text-slate-500">Trạng thái</dt><dd className="mt-2"><Badge tone={project.status === "ACTIVE" ? "green" : "amber"}>{project.status === "ACTIVE" ? "Đang hoạt động" : "Đã lưu trữ"}</Badge></dd></div><div><dt className="text-xs text-slate-500">Phân loại</dt><dd className="mt-2 text-slate-200">Hỗn hợp</dd></div><div><dt className="text-xs text-slate-500">Ngày tạo</dt><dd className="mt-2 text-slate-200">{formatDate(project.createdAt)}</dd></div><div><dt className="text-xs text-slate-500">Cập nhật</dt><dd className="mt-2 text-slate-200">{formatDate(project.updatedAt)}</dd></div></dl><div className="mt-6 border-t border-white/[0.06] pt-5"><p className="text-xs text-slate-500">Mô tả</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-300">{project.description || "Chưa có mô tả."}</p></div></Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1"><Card className="p-5"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-lg bg-blue-400/10 text-blue-300"><FolderOpen size={19} /></div><div><p className="text-2xl font-semibold">{project.assetCount}</p><p className="text-xs text-slate-500">Tài nguyên</p></div></div><p className="mt-4 text-[11px] text-slate-600">Asset Storage chưa được triển khai trong Milestone 2C.</p></Card><Card className="p-5"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-lg bg-violet-400/10 text-violet-300"><Boxes size={19} /></div><div><p className="text-2xl font-semibold">{project.renderJobCount}</p><p className="text-xs text-slate-500">Render jobs</p></div></div><p className="mt-4 text-[11px] text-slate-600">Render execution chưa được kích hoạt.</p></Card></div>
    </div>
    <Card className="p-5"><SectionTitle title="Render jobs của dự án" /><div className="mb-4 grid grid-cols-4 gap-2 text-center">{[["Đang chờ", jobSummary.queued], ["Đang chạy", jobSummary.running], ["Hoàn tất", jobSummary.succeeded], ["Thất bại", jobSummary.failed]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#0d1620] p-3"><p className="text-xl font-semibold">{value}</p><p className="mt-1 text-[10px] text-slate-500">{label}</p></div>)}</div>{jobSummary.recent.length ? <div className="space-y-2">{jobSummary.recent.map((job) => <Link key={job.id} href="/jobs" className="flex items-center justify-between rounded-lg border border-[#263648] p-3 text-xs"><span>{job.workflowVersion?.preset.name ?? "Legacy workflow"} · {job.type}</span><span className="text-slate-500">{job.status} · {job.progress}%</span></Link>)}</div> : <p className="text-sm text-slate-500">Chưa có Render Job.</p>}</Card>
    <Modal open={editOpen} title="Chỉnh sửa dự án" onClose={() => !pending && setEditOpen(false)}><form onSubmit={save} className="space-y-4"><label className="block text-xs text-slate-400">Tên dự án<input name="name" required minLength={2} maxLength={80} autoFocus defaultValue={project.name} className="field mt-1.5 h-10 px-3" /></label><label className="block text-xs text-slate-400">Mô tả<textarea name="description" maxLength={2000} defaultValue={project.description ?? ""} className="field mt-1.5 min-h-28 resize-none p-3" /></label>{formError ? <p role="alert" className="text-xs text-rose-300">{formError}</p> : null}<div className="flex justify-end gap-2"><Button type="button" disabled={pending} onClick={() => setEditOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={pending}>{pending ? "Đang lưu..." : "Lưu thay đổi"}</Button></div></form></Modal>
    <Modal open={confirmOpen} title={project.status === "ACTIVE" ? "Lưu trữ dự án?" : "Khôi phục dự án?"} onClose={() => !pending && setConfirmOpen(false)}><p className="text-sm leading-6 text-slate-400">{project.status === "ACTIVE" ? "Dự án sẽ chuyển sang chế độ chỉ đọc. Tài nguyên và render jobs liên quan không bị xóa." : "Dự án sẽ hoạt động trở lại và có thể chỉnh sửa."}</p>{formError ? <p role="alert" className="mt-3 text-xs text-rose-300">{formError}</p> : null}<div className="mt-6 flex justify-end gap-2"><Button disabled={pending} onClick={() => setConfirmOpen(false)}>Hủy</Button><Button variant={project.status === "ACTIVE" ? "danger" : "primary"} disabled={pending} onClick={transition}>{pending ? "Đang xử lý..." : project.status === "ACTIVE" ? "Xác nhận lưu trữ" : "Xác nhận khôi phục"}</Button></div></Modal>
  </div>;
}
