"use client";

import { AlertTriangle, Ban, ExternalLink, Eye, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "./page-header";
import { Badge, Button, Card, Modal } from "./ui";

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

interface JobListError { code: string; message: string; status?: number }

const LIST_TIMEOUT_MS = 15_000;
const activeStatuses = ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED"];
const tones: Record<string, "green" | "blue" | "red" | "amber" | "neutral"> = {
  SUCCEEDED: "green", RUNNING: "blue", CLAIMED: "blue", FAILED: "red", CANCELLED: "neutral",
  CANCEL_REQUESTED: "amber", QUEUED: "amber", RETRY_SCHEDULED: "amber",
};

function listError(status: number, code?: string): JobListError {
  if (status === 401) return { status, code: code ?? "JOB_UNAUTHENTICATED", message: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi thử lại." };
  if (status === 403) return { status, code: code ?? "JOB_FORBIDDEN", message: "Tài khoản hiện tại không có quyền xem lịch sử xử lý." };
  if (status >= 500) return { status, code: code ?? "JOB_SERVICE_UNAVAILABLE", message: "Dịch vụ lịch sử xử lý tạm thời không khả dụng. Vui lòng thử lại." };
  return { status, code: code ?? "JOB_LOAD_FAILED", message: "Không thể tải lịch sử xử lý. Vui lòng thử lại." };
}

async function responseBody<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

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
  const [error, setError] = useState<JobListError | null>(null);
  const listRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    listRequest.current?.controller.abort();
    const controller = new AbortController();
    const id = ++requestId.current;
    listRequest.current = { id, controller };
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, LIST_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page), pageSize: "20", sort,
      ...(status ? { status } : {}), ...(projectId ? { projectId } : {}),
      ...(type ? { type } : {}), ...(query ? { search: query } : {}),
    });

    try {
      const response = await fetch(`/api/render-jobs?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await responseBody<{ result?: { items?: JobRow[]; total?: number }; code?: string }>(response);
      if (!response.ok) { setError(listError(response.status, body?.code)); return; }
      if (!body?.result || !Array.isArray(body.result.items) || typeof body.result.total !== "number") {
        setError({ code: "JOB_RESPONSE_INVALID", message: "Máy chủ trả về dữ liệu lịch sử không hợp lệ. Vui lòng thử lại." });
        return;
      }
      setRows(body.result.items);
      setTotal(body.result.total);
    } catch (caught) {
      if (controller.signal.aborted && !timedOut) return;
      const isTimeout = timedOut || (caught instanceof DOMException && caught.name === "TimeoutError");
      setError(isTimeout
        ? { code: "JOB_REQUEST_TIMEOUT", message: "Truy vấn lịch sử xử lý mất quá nhiều thời gian. Vui lòng thử lại." }
        : { code: "JOB_NETWORK_ERROR", message: "Không thể kết nối tới dịch vụ lịch sử xử lý. Kiểm tra kết nối và thử lại." });
    } finally {
      window.clearTimeout(timeout);
      if (listRequest.current?.id === id) { listRequest.current = null; setLoading(false); }
    }
  }, [page, projectId, query, sort, status, type]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => () => listRequest.current?.controller.abort(), []);

  const open = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/render-jobs/${jobId}`, { cache: "no-store" });
      const body = await responseBody<{ job?: JobDetail; code?: string }>(response);
      if (response.ok && body?.job) setSelected(body.job); else setError(listError(response.status, body?.code));
    } catch { setError({ code: "JOB_NETWORK_ERROR", message: "Không thể tải chi tiết job. Vui lòng thử lại." }); }
  }, []);

  useEffect(() => {
    const active = rows.some((job) => activeStatuses.includes(job.status));
    const selectedActive = selected && activeStatuses.includes(selected.status);
    if (!active && !selectedActive) return;
    const timer = window.setInterval(() => { void load(); if (selectedActive) void open(selected.id); }, 4_000);
    return () => window.clearInterval(timer);
  }, [load, open, rows, selected]);

  async function mutate(jobId: string, action: "cancel" | "retry") {
    try {
      const response = await fetch(`/api/render-jobs/${jobId}/${action}`, { method: "POST" });
      const body = await responseBody<{ code?: string }>(response);
      if (!response.ok) setError(listError(response.status, body?.code ?? "JOB_ACTION_FAILED"));
      await load();
      if (selected?.id === jobId) await open(jobId);
    } catch { setError({ code: "JOB_NETWORK_ERROR", message: "Không thể cập nhật job. Vui lòng thử lại." }); }
  }

  async function openOutput(assetId: string) {
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/read-url`, { cache: "no-store" });
      const body = await responseBody<{ result?: { url?: string }; code?: string }>(response);
      if (!response.ok || !body?.result?.url) { setError(listError(response.status, body?.code ?? "ASSET_READ_FAILED")); return; }
      window.open(body.result.url, "_blank", "noopener,noreferrer");
    } catch { setError({ code: "ASSET_NETWORK_ERROR", message: "Không thể mở output của job. Vui lòng thử lại." }); }
  }

  return <div className="space-y-5">
    <PageHeader title="Lịch sử xử lý" description="Dữ liệu Render Job thật từ PostgreSQL; job đang chạy được đồng bộ định kỳ từ worker control plane." />
    <Card className="p-3"><div className="flex flex-col gap-3 sm:flex-row">
      <label className="relative flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} className="field h-10 pl-9 pr-3 text-xs" placeholder="Tìm theo tên dự án..." /></label>
      <select aria-label="Lọc dự án" className="field h-10 max-w-52 px-3 text-xs" value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); }}><option value="">Tất cả dự án</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <select aria-label="Lọc loại" className="field h-10 max-w-44 px-3 text-xs" value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="">Tất cả loại</option><option value="IMAGE_RENDER">IMAGE_RENDER</option><option value="IMAGE_UPSCALE">IMAGE_UPSCALE</option><option value="IMAGE_TO_VIDEO">IMAGE_TO_VIDEO</option></select>
      <select aria-label="Lọc trạng thái" className="field h-10 max-w-52 px-3 text-xs" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Tất cả trạng thái</option>{["QUEUED", "CLAIMED", "RUNNING", "CANCEL_REQUESTED", "RETRY_SCHEDULED", "SUCCEEDED", "FAILED", "CANCELLED"].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="Sắp xếp" className="field h-10 max-w-36 px-3 text-xs" value={sort} onChange={(event) => { setSort(event.target.value as "newest" | "oldest"); setPage(1); }}><option value="newest">Mới nhất</option><option value="oldest">Cũ nhất</option></select>
      <Button onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Làm mới</Button>
    </div></Card>

    {error ? <Card role="alert" className="border-rose-500/30 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3"><AlertTriangle className="mt-0.5 shrink-0 text-rose-300" size={18} /><div><p className="text-sm font-medium text-rose-200">Không tải được lịch sử xử lý</p><p className="mt-1 text-xs text-slate-400">{error.message}</p><p className="mt-1 font-mono text-[10px] text-slate-600">{error.code}{error.status ? ` · HTTP ${error.status}` : ""}</p></div></div>
      <Button onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> Thử lại</Button>
    </div></Card> : null}

    <Card className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-xs"><thead className="border-b border-[#253548] bg-[#111b26] text-slate-500"><tr>{["Job ID", "Dự án", "Loại", "Workflow", "Trạng thái", "Tiến trình", "Retry", "Tạo lúc", "Thao tác"].map((heading) => <th key={heading} className="px-3 py-3 font-medium">{heading}</th>)}</tr></thead><tbody>
      {rows.map((job) => <tr key={job.id} className="border-b border-white/[0.05] hover:bg-white/[0.025]"><td className="px-3 py-3 font-mono text-blue-300">{job.id.slice(0, 12)}…</td><td className="px-3 py-3 font-medium">{job.project.name}</td><td className="px-3 py-3">{job.type}</td><td className="px-3 py-3 text-slate-400">{job.workflowVersion ? `${job.workflowVersion.preset.name} v${job.workflowVersion.version}` : "—"}</td><td className="px-3 py-3"><Badge tone={tones[job.status] ?? "neutral"}>{job.status}</Badge></td><td className="px-3 py-3"><div className="h-1.5 w-24 overflow-hidden rounded bg-slate-800"><div className="h-full bg-blue-400" style={{ width: `${Number(job.progress)}%` }} /></div><span className="mt-1 block text-[10px] text-slate-500">{Number(job.progress)}%</span></td><td className="px-3 py-3">{job.retryCount}/{job.maxRetries}</td><td className="px-3 py-3 text-slate-500">{new Date(job.createdAt).toLocaleString()}</td><td className="px-3 py-3"><div className="flex gap-1"><Button variant="ghost" className="h-8 w-8 px-0" onClick={() => void open(job.id)} aria-label="Xem chi tiết"><Eye size={14} /></Button>{job.status === "FAILED" ? <Button variant="ghost" className="h-8 w-8 px-0" onClick={() => void mutate(job.id, "retry")} aria-label="Thử lại"><RefreshCw size={14} /></Button> : null}{["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"].includes(job.status) ? <Button variant="ghost" className="h-8 w-8 px-0 text-rose-300" onClick={() => void mutate(job.id, "cancel")} aria-label="Hủy"><Ban size={14} /></Button> : null}</div></td></tr>)}
      {loading && rows.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400"><span className="inline-flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" /> Đang tải lịch sử xử lý…</span></td></tr> : null}
      {!loading && !error && rows.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center"><p className="font-medium text-slate-300">Chưa có lịch sử xử lý</p><p className="mt-1 text-slate-500">Các render job mới sẽ xuất hiện tại đây sau khi được tạo.</p></td></tr> : null}
      {!loading && error && rows.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-500">Dữ liệu chưa được tải. Chọn “Thử lại” ở thông báo phía trên.</td></tr> : null}
    </tbody></table><div className="flex items-center justify-between border-t border-[#253548] p-3 text-xs text-slate-500"><span>{total} jobs · trang {page}/{Math.max(1, Math.ceil(total / 20))}</span><div className="flex gap-2"><Button disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Trước</Button><Button disabled={page * 20 >= total || loading} onClick={() => setPage((value) => value + 1)}>Sau</Button></div></div></Card>
    <Modal open={Boolean(selected)} title={`Chi tiết Job ${selected?.id.slice(0, 12) ?? ""}`} onClose={() => setSelected(null)}>{selected ? <div className="space-y-4 text-xs"><div className="grid grid-cols-2 gap-3">{[["Dự án", selected.project.name], ["Trạng thái", selected.status], ["Workflow", selected.workflowVersion?.preset.name ?? "—"], ["Inputs", String(selected.inputs.length)]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#0d1620] p-3"><p className="text-slate-500">{label}</p><p className="mt-1 font-medium">{value}</p></div>)}</div><div><p className="mb-2 font-medium">Input assets</p>{selected.inputs.map((input) => <div key={`${input.asset.id}-${input.role}`} className="rounded-lg border border-[#263648] p-2 text-slate-400">{input.role} · {input.asset.originalName ?? input.asset.id} · {input.asset.type}</div>)}</div><div><p className="mb-2 font-medium">Verified outputs</p>{selected.outputs.length ? selected.outputs.map((output) => <div key={`${output.asset.id}-${output.role}`} className="flex items-center justify-between rounded-lg border border-[#263648] p-2 text-slate-400"><span>{output.role} · {output.asset.originalName ?? output.asset.id} · {output.asset.integrityStatus}</span><Button variant="ghost" className="h-8 px-2" onClick={() => void openOutput(output.asset.id)} disabled={output.asset.status !== "READY" || output.asset.integrityStatus !== "VERIFIED_IMMUTABLE"}><ExternalLink size={13} /> Mở</Button></div>) : <p className="text-slate-500">Chưa có output đã xác minh.</p>}</div><div><p className="mb-2 font-medium">Parameter snapshot</p><pre className="max-h-36 overflow-auto rounded-lg bg-[#0d1620] p-3 text-[10px] text-slate-400">{JSON.stringify(selected.parameters, null, 2)}</pre></div><div><p className="mb-2 font-medium">Attempts</p>{selected.attempts.length ? selected.attempts.map((attempt) => <div key={attempt.id} className="rounded-lg border border-[#263648] p-2 text-slate-400">#{attempt.attemptNumber} · {attempt.status}{attempt.errorCode ? ` · ${attempt.errorCode}` : ""}</div>) : <p className="text-slate-500">Chưa được worker claim.</p>}</div><div><p className="mb-2 font-medium">Timeline</p><div className="max-h-64 space-y-2 overflow-y-auto">{selected.events.map((event) => <div key={event.id} className="rounded-lg border border-[#263648] p-3"><span className="font-mono text-slate-500">#{event.sequence}</span> {event.fromStatus ?? "—"} → {event.toStatus ?? "—"}<p className="mt-1 text-slate-500">{event.message}</p></div>)}</div></div></div> : null}</Modal>
  </div>;
}
