"use client";

import type { ProjectListResult } from "@archrender/projects/types";
import { createProjectSchema } from "@archrender/projects/schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronLeft, ChevronRight, FolderKanban, Grid2X2, List, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Badge, Button, Card, Modal } from "./ui";
import { PageHeader } from "./page-header";

const clientCreateSchema = createProjectSchema.omit({ requestId: true });
type CreateFormInput = z.input<typeof clientCreateSchema>;
type CreateFormOutput = z.output<typeof clientCreateSchema>;
type Filters = { search: string; status: "ALL" | "ACTIVE" | "ARCHIVED"; sort: "createdAt" | "updatedAt" | "name"; direction: "asc" | "desc" };

function formatDate(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

export function ProjectsPage({ data, filters }: { data: ProjectListResult; filters: Filters }) {
  const router = useRouter();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isNavigating, startTransition] = useTransition();
  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<CreateFormInput, undefined, CreateFormOutput>({ resolver: zodResolver(clientCreateSchema), defaultValues: { name: "", description: "" } });

  function navigate(next: Partial<Filters> & { page?: number }) {
    const params = new URLSearchParams();
    const values = { ...filters, ...next };
    if (values.search) params.set("search", values.search);
    params.set("status", values.status); params.set("sort", values.sort); params.set("direction", values.direction); params.set("page", String(next.page ?? 1));
    startTransition(() => router.push(`/projects?${params.toString()}`));
  }

  async function createProject(values: CreateFormOutput) {
    setNotice(null);
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, requestId: crypto.randomUUID() }) });
    const payload = (await response.json()) as { project?: { id: string }; issues?: { name?: string[]; description?: string[] } };
    if (!response.ok || !payload.project) {
      if (payload.issues?.name?.[0]) setError("name", { message: payload.issues.name[0] });
      if (payload.issues?.description?.[0]) setError("description", { message: payload.issues.description[0] });
      if (!payload.issues) setNotice("Không thể tạo dự án. Vui lòng thử lại.");
      return;
    }
    reset(); setOpen(false); router.push(`/projects/${payload.project.id}`); router.refresh();
  }

  return <div className="space-y-5">
    <PageHeader title="Dự án của tôi" description="Tổ chức render nguồn, kết quả, video và lịch sử xử lý theo từng công trình." actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} /> Tạo dự án</Button>} />
    {notice ? <div role="status" className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-xs text-rose-200">{notice}</div> : null}
    <Card className="p-3"><form className="flex flex-col gap-3 lg:flex-row" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); navigate({ search: String(form.get("search") ?? "").trim(), page: 1 }); }}>
      <label className="relative flex-1"><span className="sr-only">Tìm dự án</span><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" /><input name="search" maxLength={100} defaultValue={filters.search} className="field h-10 pl-9 pr-3 text-xs" placeholder="Tìm theo tên dự án..." /></label>
      <select aria-label="Trạng thái dự án" className="field h-10 px-3 text-xs lg:w-40" value={filters.status} onChange={(event) => navigate({ status: event.target.value as Filters["status"] })}><option value="ACTIVE">Đang hoạt động</option><option value="ARCHIVED">Đã lưu trữ</option><option value="ALL">Tất cả</option></select>
      <select aria-label="Sắp xếp dự án" className="field h-10 px-3 text-xs lg:w-48" value={`${filters.sort}:${filters.direction}`} onChange={(event) => { const [sort, direction] = event.target.value.split(":") as [Filters["sort"], Filters["direction"]]; navigate({ sort, direction }); }}><option value="updatedAt:desc">Mới cập nhật</option><option value="createdAt:desc">Mới tạo</option><option value="name:asc">Tên A–Z</option><option value="name:desc">Tên Z–A</option></select>
      <Button type="submit" disabled={isNavigating}>Tìm kiếm</Button><div className="flex rounded-lg border border-[#273748] bg-[#0d1620] p-1"><button type="button" aria-label="Dạng lưới" onClick={() => setView("grid")} className={`rounded p-2 ${view === "grid" ? "bg-[#253449] text-blue-300" : "text-slate-500"}`}><Grid2X2 size={15} /></button><button type="button" aria-label="Dạng bảng" onClick={() => setView("list")} className={`rounded p-2 ${view === "list" ? "bg-[#253449] text-blue-300" : "text-slate-500"}`}><List size={15} /></button></div>
    </form></Card>
    {data.items.length === 0 ? <Card className="grid min-h-64 place-items-center p-8 text-center"><div><FolderKanban size={34} className="mx-auto text-slate-600" /><h2 className="mt-4 font-semibold">Không tìm thấy dự án</h2><p className="mt-2 text-xs text-slate-500">Thay đổi bộ lọc hoặc tạo dự án đầu tiên của bạn.</p></div></Card> : view === "grid" ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{data.items.map((project) => <Link key={project.id} href={`/projects/${project.id}`} className="group"><Card className="h-full overflow-hidden transition group-hover:-translate-y-0.5 group-hover:border-[#3a516a]"><div className="grid aspect-[16/8] place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(91,127,255,.22),transparent_55%),linear-gradient(135deg,#111d29,#0b121a)]"><FolderKanban size={28} className="text-blue-300/80" /></div><div className="p-4"><div className="flex items-start justify-between gap-3"><h2 className="font-semibold text-slate-100">{project.name}</h2><Badge tone={project.status === "ACTIVE" ? "green" : "amber"}>{project.status === "ACTIVE" ? "Hoạt động" : "Lưu trữ"}</Badge></div><p className="mt-2 line-clamp-2 min-h-8 text-[11px] leading-4 text-slate-500">{project.description || "Chưa có mô tả."}</p><div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-3 text-[11px] text-slate-400"><span>{project.assetCount} tài nguyên</span><span>{project.renderJobCount} tác vụ</span></div><p className="mt-2 text-[10px] text-slate-600">Cập nhật {formatDate(project.updatedAt)}</p></div></Card></Link>)}</div> : <Card className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-[#243244] bg-[#111b26] text-slate-500"><tr>{["Dự án", "Trạng thái", "Tài nguyên", "Tác vụ", "Cập nhật"].map((header) => <th key={header} className="px-4 py-3 font-medium">{header}</th>)}</tr></thead><tbody>{data.items.map((project) => <tr key={project.id} className="border-b border-white/[0.05] hover:bg-white/[0.02]"><td className="px-4 py-3"><Link href={`/projects/${project.id}`} className="font-medium text-slate-100 hover:text-blue-300">{project.name}</Link><p className="mt-1 max-w-sm truncate text-[10px] text-slate-600">{project.description || "Chưa có mô tả"}</p></td><td className="px-4 py-3"><Badge tone={project.status === "ACTIVE" ? "green" : "amber"}>{project.status === "ACTIVE" ? "Hoạt động" : "Lưu trữ"}</Badge></td><td className="px-4 py-3">{project.assetCount}</td><td className="px-4 py-3">{project.renderJobCount}</td><td className="px-4 py-3 text-slate-500">{formatDate(project.updatedAt)}</td></tr>)}</tbody></table></Card>}
    <div className="flex items-center justify-between text-xs text-slate-500"><span>{data.total} dự án · Trang {data.page}/{data.pageCount}</span><div className="flex gap-2"><Button disabled={data.page <= 1 || isNavigating} onClick={() => navigate({ page: data.page - 1 })}><ChevronLeft size={15} /> Trước</Button><Button disabled={data.page >= data.pageCount || isNavigating} onClick={() => navigate({ page: data.page + 1 })}>Sau <ChevronRight size={15} /></Button></div></div>
    <Modal open={open} title="Tạo dự án" onClose={() => !isSubmitting && setOpen(false)}><form onSubmit={handleSubmit(createProject)} className="space-y-4"><label className="block text-xs text-slate-400">Tên dự án<input {...register("name")} autoFocus className="field mt-1.5 h-10 px-3" placeholder="Ví dụ: Villa Riverside" />{errors.name ? <span className="mt-1 block text-[11px] text-rose-300">{errors.name.message}</span> : null}</label><label className="block text-xs text-slate-400">Mô tả<textarea {...register("description")} className="field mt-1.5 min-h-28 resize-none p-3" placeholder="Mô tả ngắn về công trình..." />{errors.description ? <span className="mt-1 block text-[11px] text-rose-300">{errors.description.message}</span> : null}</label><p className="text-[11px] text-slate-600">Asset Storage và Render execution chưa được kích hoạt.</p><div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)} disabled={isSubmitting}>Hủy</Button><Button type="submit" variant="primary" disabled={isSubmitting}>{isSubmitting ? "Đang tạo..." : "Tạo dự án"}</Button></div></form></Modal>
  </div>;
}
