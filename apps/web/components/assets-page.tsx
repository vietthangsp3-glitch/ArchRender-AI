"use client";

import { ArrowDownToLine, ChevronLeft, ChevronRight, MoreHorizontal, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ASSET_TYPES,
  assetErrorMessage,
  deleteAsset,
  getAsset,
  getAssetReadUrl,
  listAssets,
  type AssetListResult,
  type AssetStatus,
  type AssetSummary,
  type AssetType,
} from "@/lib/assets/client";
import { AssetPreview } from "./asset-preview";
import { AssetUploadDialog } from "./asset-upload-dialog";
import { PageHeader } from "./page-header";
import { Badge, Button, Card, Modal } from "./ui";

const TYPE_LABELS: Record<AssetType, string> = {
  SOURCE_IMAGE: "Ảnh nguồn", REFERENCE_IMAGE: "Ảnh tham chiếu", SOURCE_RENDER: "Source Render",
  DEPTH_MAP: "Depth Map", NORMAL_MAP: "Normal Map", CANNY_MAP: "Canny Map",
  GENERATED_IMAGE: "Ảnh đã tạo", GENERATED_VIDEO: "Video đã tạo", WORKFLOW_FILE: "Workflow",
};
const STATUS_LABELS: Record<AssetStatus, string> = {
  PENDING_UPLOAD: "Chờ tải lên", VERIFYING: "Đang xác minh", READY: "READY",
  REJECTED: "Bị từ chối", QUARANTINED: "Cách ly",
};
function statusTone(status: AssetStatus): "green" | "blue" | "amber" | "red" {
  if (status === "READY") return "green";
  if (status === "VERIFYING") return "blue";
  if (status === "REJECTED" || status === "QUARANTINED") return "red";
  return "amber";
}
function fileSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function dimensions(asset: AssetSummary): string {
  return asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Chưa xác định";
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium" }).format(new Date(value));
}

export function AssetsPage({ projectOptions }: {
  projectOptions: Array<{ id: string; name: string; status: "ACTIVE" | "ARCHIVED" }>;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [assetType, setAssetType] = useState<"" | AssetType>("");
  const [status, setStatus] = useState<"" | AssetStatus>("");
  const [sort, setSort] = useState<"newest" | "oldest" | "name" | "size">("newest");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AssetListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AssetSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
      setLoading(true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    listAssets({
      ...(projectId ? { projectId } : {}), ...(assetType ? { assetType } : {}),
      ...(status ? { status } : {}), ...(debouncedQuery ? { search: debouncedQuery } : {}),
      sort, page, pageSize: 20,
    }, controller.signal).then((next) => { setError(null); setResult(next); }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(assetErrorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [assetType, debouncedQuery, page, projectId, refreshToken, sort, status]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    getAsset(selectedId, controller.signal).then((next) => { setDetailError(null); setSelected(next); }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setDetailError(assetErrorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => Boolean(projectId || assetType || status || debouncedQuery), [assetType, debouncedQuery, projectId, status]);
  const openDetail = (assetId: string) => {
    setSelected(null); setDetailError(null); setDetailLoading(true); setSelectedId(assetId);
  };
  const closeDetail = () => {
    setSelectedId(null); setSelected(null); setDetailError(null); setDetailLoading(false);
  };
  const download = async (asset: AssetSummary) => {
    try {
      const read = await getAssetReadUrl(asset.id);
      const anchor = document.createElement("a");
      anchor.href = read.url; anchor.download = asset.originalName ?? "asset"; anchor.rel = "noopener noreferrer"; anchor.click();
    } catch (reason) { setToast(assetErrorMessage(reason)); }
  };
  const remove = async (asset: AssetSummary) => {
    if (!window.confirm(`Yêu cầu xóa “${asset.originalName ?? "tài nguyên"}”? Object sẽ được dọn bởi tác vụ bảo trì.`)) return;
    try {
      await deleteAsset(asset.id); closeDetail(); setToast("Đã ghi nhận yêu cầu xóa an toàn."); setLoading(true); setRefreshToken((value) => value + 1);
    } catch (reason) { setToast(assetErrorMessage(reason)); }
  };

  return <div className="space-y-5">
    <PageHeader title="Thư viện tài nguyên" description="Quản lý ảnh nguồn, bản đồ điều khiển và kết quả đã được xác minh trong kho lưu trữ riêng tư." actions={<Button variant="primary" onClick={() => setUploadOpen(true)} disabled={!result || !projectOptions.some((project) => project.status === "ACTIVE")}><Upload size={16} /> Tải tài nguyên</Button>} />
    <Card className="p-3"><div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(138px,auto))]">
      <label className="relative"><span className="sr-only">Tìm theo tên tệp</span><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="field h-10 pl-9 pr-3 text-xs" placeholder="Tìm theo tên tệp..." /></label>
      <select aria-label="Lọc theo dự án" className="field h-10 px-3 text-xs" value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); setLoading(true); }}><option value="">Mọi dự án</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}{project.status === "ARCHIVED" ? " · lưu trữ" : ""}</option>)}</select>
      <select aria-label="Lọc theo loại" className="field h-10 px-3 text-xs" value={assetType} onChange={(event) => { setAssetType(event.target.value as "" | AssetType); setPage(1); setLoading(true); }}><option value="">Mọi loại</option>{ASSET_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}</select>
      <select aria-label="Lọc theo trạng thái" className="field h-10 px-3 text-xs" value={status} onChange={(event) => { setStatus(event.target.value as "" | AssetStatus); setPage(1); setLoading(true); }}><option value="">Mọi trạng thái</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="Sắp xếp" className="field h-10 px-3 text-xs" value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setPage(1); setLoading(true); }}><option value="newest">Mới nhất</option><option value="oldest">Cũ nhất</option><option value="name">Tên A–Z</option><option value="size">Dung lượng</option></select>
    </div></Card>
    {error ? <Card className="flex min-h-52 flex-col items-center justify-center gap-3 p-8 text-center"><p className="text-sm text-rose-200">{error}</p><Button onClick={() => { setLoading(true); setRefreshToken((value) => value + 1); }}><RefreshCw size={15} /> Thử lại</Button></Card> : null}
    {!error && loading ? <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{Array.from({ length: 10 }, (_, index) => <Card key={index} className="overflow-hidden"><div className="aspect-[16/11] animate-pulse bg-slate-800/60" /><div className="space-y-2 p-3"><div className="h-3 w-3/4 animate-pulse rounded bg-slate-700" /><div className="h-2.5 w-1/2 animate-pulse rounded bg-slate-800" /></div></Card>)}</div> : null}
    {!error && !loading && result?.items.length ? <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{result.items.map((asset) => <Card key={asset.id} className="group overflow-hidden">
      <button className="relative block aspect-[16/11] w-full overflow-hidden text-left" onClick={() => openDetail(asset.id)}><AssetPreview assetId={asset.id} status={asset.status} alt={asset.originalName ?? "Tài nguyên"} className={`h-full w-full object-cover transition duration-300 group-hover:scale-105 ${asset.assetType === "DEPTH_MAP" ? "grayscale" : ""}`} /><Badge className="absolute left-2.5 top-2.5 border-0 bg-black/70">{TYPE_LABELS[asset.assetType]}</Badge><Badge tone={statusTone(asset.status)} className="absolute right-2.5 top-2.5 bg-black/70">{asset.uploadExpired ? "Đã hết hạn" : STATUS_LABELS[asset.status]}</Badge></button>
      <div className="p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{asset.originalName ?? "Không có tên"}</p><p className="mt-1 truncate text-[10px] text-slate-500">{asset.project?.name ?? "Không có dự án"}</p><p className="mt-1 text-[10px] text-slate-600">{dimensions(asset)} · {fileSize(asset.byteSize)} · {formatDate(asset.createdAt)}</p></div><button className="rounded p-1 text-slate-500 hover:bg-white/5" onClick={() => openDetail(asset.id)} aria-label={`Mở ${asset.originalName ?? "tài nguyên"}`}><MoreHorizontal size={15} /></button></div></div>
    </Card>)}</div> : null}
    {!error && !loading && result?.items.length === 0 ? <Card className="grid min-h-52 place-items-center p-8 text-center"><div><p className="text-sm text-slate-300">{filtered ? "Không tìm thấy tài nguyên phù hợp." : "Thư viện chưa có tài nguyên."}</p><p className="mt-2 text-xs text-slate-500">{filtered ? "Hãy thay đổi bộ lọc hoặc từ khóa." : "Chọn một dự án ACTIVE để tải ảnh đầu tiên."}</p></div></Card> : null}
    {result && result.pageCount > 1 ? <div className="flex items-center justify-between"><p className="text-xs text-slate-500">Trang {result.page}/{result.pageCount} · {result.total} tài nguyên</p><div className="flex gap-2"><Button onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }} disabled={page <= 1}><ChevronLeft size={15} /> Trước</Button><Button onClick={() => { setLoading(true); setPage((value) => Math.min(result.pageCount, value + 1)); }} disabled={page >= result.pageCount}>Sau <ChevronRight size={15} /></Button></div></div> : null}
    <Modal open={Boolean(selectedId)} title="Chi tiết tài nguyên" onClose={closeDetail}>
      {detailLoading ? <div className="h-72 animate-pulse rounded-xl bg-slate-800/60" /> : null}
      {detailError ? <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-200">{detailError}</p> : null}
      {selected ? <div><div className="relative aspect-video overflow-hidden rounded-xl"><AssetPreview assetId={selected.id} status={selected.status} alt={selected.originalName ?? "Tài nguyên"} eager /></div><dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-500">Tên tệp</dt><dd className="mt-1 break-words font-medium">{selected.originalName ?? "—"}</dd></div><div><dt className="text-slate-500">Trạng thái</dt><dd className="mt-1"><Badge tone={statusTone(selected.status)}>{selected.uploadExpired ? "Đã hết hạn" : STATUS_LABELS[selected.status]}</Badge></dd></div><div><dt className="text-slate-500">Loại</dt><dd className="mt-1">{TYPE_LABELS[selected.assetType]}</dd></div><div><dt className="text-slate-500">Dự án</dt><dd className="mt-1">{selected.project?.name ?? "—"}{selected.project?.status === "ARCHIVED" ? " · đã lưu trữ" : ""}</dd></div><div><dt className="text-slate-500">MIME / dung lượng</dt><dd className="mt-1">{selected.contentType ?? "—"} · {fileSize(selected.byteSize)}</dd></div><div><dt className="text-slate-500">Độ phân giải</dt><dd className="mt-1">{dimensions(selected)}</dd></div><div><dt className="text-slate-500">Ngày tải lên</dt><dd className="mt-1">{formatDate(selected.createdAt)}</dd></div><div><dt className="text-slate-500">Xác minh</dt><dd className="mt-1">{selected.verifiedAt ? formatDate(selected.verifiedAt) : "Chưa hoàn tất"}</dd></div></dl><div className="mt-5 flex flex-wrap gap-2"><Button variant="primary" className="flex-1" onClick={() => download(selected)} disabled={selected.status !== "READY"}><ArrowDownToLine size={15} /> Tải xuống</Button><Button variant="danger" className="flex-1" onClick={() => remove(selected)} disabled={selected.project?.status === "ARCHIVED"}><Trash2 size={15} /> Yêu cầu xóa</Button></div>{selected.project?.status === "ARCHIVED" ? <p className="mt-3 text-[11px] text-amber-200">Dự án đã lưu trữ: chỉ cho phép xem và tải xuống tài nguyên READY.</p> : null}</div> : null}
    </Modal>
    {result ? <AssetUploadDialog open={uploadOpen} projects={projectOptions} policy={result.policy} onClose={() => setUploadOpen(false)} onUploaded={() => { setToast("Tài nguyên đã được xác minh READY."); setLoading(true); setRefreshToken((value) => value + 1); }} /> : null}
    {toast ? <div className="fixed bottom-5 right-5 z-[100] max-w-sm rounded-xl border border-blue-400/20 bg-[#111c28] px-4 py-3 text-xs text-slate-100 shadow-2xl" role="status">{toast}</div> : null}
  </div>;
}
