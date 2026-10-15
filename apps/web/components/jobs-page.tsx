"use client";

import { Ban, ExternalLink, Eye, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, Modal } from "./ui";
import { PageHeader } from "./page-header";

interface JobRow {
  id: string; type: string; status: string; progress: string | number;
  retryCount: number; maxRetries: number; errorCode: string | null; createdAt: string;
  project: { id: string; name: string };
  workflowVersion: { id: string; version: number; preset: { name: string } } | null;
}

interface JobDetail extends JobRow {
  parameters: Record<string, unknown>;
  events: Array<{ id: string; sequence: number; type: string; fromStatus: string | null; toStatus: string | null; message: string | null; createdAt: string }>;
  attempts: Array<{ id: string; attemptNumber: number; status: string; errorCode: string | null; createdAt: string }>;
  inputs: Array<{ asset: { id: string; originalName: string | null; type: string }; role: string }>;
  outputs: Array<{ asset: { id: string; originalName: string | null; type: string; contentType: string | null; status: string; integrityStatus: string }; role: string; position: number }>;
}

const tones: Record<string, "green" | "blue" | "red" | "amber" | "neutral"> = {
  SUCCEEDED: "green", RUNNING: "blue", CLAIMED: "blue", FAILED: "red", CANCELLED: "neutral",
  CANCEL_REQUESTED: "amber", QUEUED: "amber", RETRY_SCHEDULED: "amber",
};

export function JobsPage({ projectOptions = [] }: { projectOptions?: Array<{ id: string; name: string }> }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<JobRow[]>([]);
  const [selected, setSelected] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: "20", sort, ...(status ? { status } : {}), ...(projectId ? { projectId } : {}), ...(type ? { type } : {}), ...(query ? { search: query } : {}) });
    const response = await fetch(`/api/render-jobs?${params}`, { cache: "no-store" });
    const body = await response.json() as { result?: { items?: JobRow[]; total?: number }; code?: string };
    if (!response.ok) setError(body.code ?? "JOB_LOAD_FAILED");
    else { setRows(body.result?.items ?? []); setTotal(body.result?.total ?? 0); setError(null); }
    setLoading(false);
  }, [page, projectId, query, sort, status, type]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => clearTimeout(timer); }, [load]);

  const open = useCallback(async (jobId: string) => {
    const response = await fetch(`/api/render-jobs/${jobId}`, { cache: "no-store" });
    const body = await response.json() as { job?: JobDetail; code?: string };
    if (response.ok && body.job) setSelected(body.job); else setError(body.code ?? "JOB_LOAD_FAILED");
  }, []);

  useEffect(() => {
    const active = rows.some((job) => ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED"].includes(job.status));
    const selectedActive = selected && ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED"].includes(selected.status);
    if (!active && !selectedActive) return;
    const timer = window.setInterval(() => {
      void load();
      if (selectedActive) void open(selected.id);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [load, open, rows, selected]);

  async function mutate(jobId: string, action: "cancel" | "retry") {
    const response = await fetch(`/api/render-jobs/${jobId}/${action}`, { method: "POST" });
    const body = await response.json() as { code?: string };
    if (!response.ok) setError(body.code ?? "JOB_ACTION_FAILED");
    await load();
    if (selected?.id === jobId) await open(jobId);
  }

  async function openOutput(assetId: string) {
    const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/read-url`, { cache: "no-store" });
    const body = await response.json() as { result?: { url?: string }; code?: string };
    if (!response.ok || !body.result?.url) { setError(body.code ?? "ASSET_READ_FAILED"); return; }
    window.open(body.result.url, "_blank", "noopener,noreferrer");
  }

  return <div className="space-y-5">
    <PageHeader title="Lịch sử xử lý" description="Dữ liệu Render Job thật từ PostgreSQL; job đang chạy được đồng bộ định kỳ từ worker control plane." />
    <Card className="p-3"><div className="flex flex-col gap-3 sm:flex-row">
      <label className="relative flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="field h-10 pl-9 pr-3 text-xs" placeholder="Tìm theo tên dự án..." /></label>
      <select aria-label="Lọc dự án" className="field h-10 max-w-52 px-3 text-xs" value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); }}><option value="">Tất cả dự án</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <select aria-label="Lọc loại" className="field h-10 max-w-44 px-3 text-xs" value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="">Tất cả loại</option><option value="IMAGE_RENDER">IMAGE_RENDER</option><option value="IMAGE_UPSCALE">IMAGE_UPSCALE</option><option value="IMAGE_TO_VIDEO">IMAGE_TO_VIDEO</option></select>
      <select className="field h-10 max-w-52 px-3 text-xs" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tất cả trạng thái</option>{["QUEUED", "CLAIMED", "RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED", "SUCCEEDED", "FAILED", "CANCELLED"].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="Sắp xếp" className="field h-10 max-w-36 px-3 text-xs" value={sort} onChange={(event) => { setSort(event.target.value as "newest" | "oldest"); setPage(1); }}><option value="newest">Mới nhất</option><option value="oldest">Cũ nhất</option></select>
      <Button onClick={() => void load()}><RefreshCw size={15} /> Làm mới</Button>
    </div>{error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}</Card>
    <Card className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-xs"><thead className="border-b border-[#253548] bg-[#111b26] text-slate-500"><tr>{["Job ID", "Dự án", "Loại", "Workflow", "Trạng thái", "Tiến trình", "Retry", "Tạo lúc", "Thao tác"].map((heading) => <th key={heading} className="px-3 py-3 font-medium">{heading}</th>)}</tr></thead><tbody>
      {rows.map((job) => <tr key={job.id} className="border-b border-white/[0.05] hover:bg-white/[0.025]"><td className="px-3 py-3 font-mono text-blue-300">{job.id.slice(0, 12)}…</td><td className="px-3 py-3 font-medium">{job.project.name}</td><td className="px-3 py-3">{job.type}</td><td className="px-3 py-3 text-slate-400">{job.workflowVersion ? `${job.workflowVersion.preset.name} v${job.workflowVersion.version}` : "—"}</td><td className="px-3 py-3"><Badge tone={tones[job.status] ?? "neutral"}>{job.status}</Badge></td><td className="px-3 py-3"><div className="h-1.5 w-24 overflow-hidden rounded bg-slate-800"><div className="h-full bg-blue-400" style={{ width: `${Number(job.progress)}%` }} /></div><span className="mt-1 block text-[10px] text-slate-500">{Number(job.progress)}%</span></td><td className="px-3 py-3">{job.retryCount}/{job.maxRetries}</td><td className="px-3 py-3 text-slate-500">{new Date(job.createdAt).toLocaleString()}</td><td className="px-3 py-3"><div className="flex gap-1"><Button variant="ghost" className="h-8 w-8 px-0" onClick={() => void open(job.id)} aria-label="Xem chi tiết"><Eye size={14} /></Button>{job.status === "FAILED" ? <Button variant="ghost" className="h-8 w-8 px-0" onClick={() => void mutate(job.id, "retry")} aria-label="Thử lại"><RefreshCw size={14} /></Button> : null}{["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"].includes(job.status) ? <Button variant="ghost" className="h-8 w-8 px-0 text-rose-300" onClick={() => void mutate(job.id, "cancel")} aria-label="Hủy"><Ban size={14} /></Button> : null}</div></td></tr>)}
      {!loading && rows.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-500">Chưa có Render Job phù hợp.</td></tr> : null}
    </tbody></table><div className="flex items-center justify-between border-t border-[#253548] p-3 text-xs text-slate-500"><span>{total} jobs · trang {page}/{Math.max(1, Math.ceil(total / 20))}</span><div className="flex gap-2"><Button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Trước</Button><Button disabled={page * 20 >= total} onClick={() => setPage((value) => value + 1)}>Sau</Button></div></div></Card>
    <Modal open={Boolean(selected)} title={`Chi tiết Job ${selected?.id.slice(0, 12) ?? ""}`} onClose={() => setSelected(null)}>{selected ? <div className="space-y-4 text-xs"><div className="grid grid-cols-2 gap-3">{[["Dự án", selected.project.name], ["Trạng thái", selected.status], ["Workflow", selected.workflowVersion?.preset.name ?? "—"], ["Inputs", String(selected.inputs.length)]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#0d1620] p-3"><p className="text-slate-500">{label}</p><p className="mt-1 font-medium">{value}</p></div>)}</div><div><p className="mb-2 font-medium">Input assets</p>{selected.inputs.map((input) => <div key={`${input.asset.id}-${input.role}`} className="rounded-lg border border-[#263648] p-2 text-slate-400">{input.role} · {input.asset.originalName ?? input.asset.id} · {input.asset.type}</div>)}</div><div><p className="mb-2 font-medium">Verified outputs</p>{selected.outputs.length ? selected.outputs.map((output) => <div key={`${output.asset.id}-${output.role}`} className="flex items-center justify-between rounded-lg border border-[#263648] p-2 text-slate-400"><span>{output.role} · {output.asset.originalName ?? output.asset.id} · {output.asset.integrityStatus}</span><Button variant="ghost" className="h-8 px-2" onClick={() => void openOutput(output.asset.id)} disabled={output.asset.status !== "READY" || output.asset.integrityStatus !== "VERIFIED_IMMUTABLE"}><ExternalLink size={13} /> Mở</Button></div>) : <p className="text-slate-500">Chưa có output đã xác minh.</p>}</div><div><p className="mb-2 font-medium">Parameter snapshot</p><pre className="max-h-36 overflow-auto rounded-lg bg-[#0d1620] p-3 text-[10px] text-slate-400">{JSON.stringify(selected.parameters, null, 2)}</pre></div><div><p className="mb-2 font-medium">Attempts</p>{selected.attempts.length ? selected.attempts.map((attempt) => <div key={attempt.id} className="rounded-lg border border-[#263648] p-2 text-slate-400">#{attempt.attemptNumber} · {attempt.status}{attempt.errorCode ? ` · ${attempt.errorCode}` : ""}</div>) : <p className="text-slate-500">Chưa được worker claim.</p>}</div><div><p className="mb-2 font-medium">Timeline</p><div className="max-h-64 space-y-2 overflow-y-auto">{selected.events.map((event) => <div key={event.id} className="rounded-lg border border-[#263648] p-3"><span className="font-mono text-slate-500">#{event.sequence}</span> {event.fromStatus ?? "—"} → {event.toStatus ?? "—"}<p className="mt-1 text-slate-500">{event.message}</p></div>)}</div></div></div> : null}</Modal>
  </div>;
}
