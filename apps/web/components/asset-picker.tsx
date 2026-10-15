"use client";

import { ChevronLeft, ChevronRight, Images, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  assetErrorMessage,
  listAssets,
  type AssetSummary,
  type AssetType,
} from "@/lib/assets/client";
import { AssetPreview } from "./asset-preview";
import { Badge, Button, Card } from "./ui";

const TYPE_LABELS: Partial<Record<AssetType, string>> = {
  SOURCE_IMAGE: "Ảnh nguồn",
  REFERENCE_IMAGE: "Ảnh tham chiếu",
  DEPTH_MAP: "Depth Map",
  NORMAL_MAP: "Normal Map",
  CANNY_MAP: "Canny Map",
};

export function AssetPicker({
  label,
  projectId,
  allowedTypes,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  projectId: string;
  allowedTypes: readonly AssetType[];
  value: AssetSummary | null;
  onChange: (asset: AssetSummary | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AssetType>(allowedTypes[0]!);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
      setLoading(true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!open || !projectId) return;
    const controller = new AbortController();
    listAssets({ projectId, assetType: type, status: "READY", search: debouncedQuery, page, pageSize: 12 }, controller.signal)
      .then((result) => { setError(null); setItems(result.items); setPageCount(result.pageCount); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(assetErrorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [debouncedQuery, open, page, projectId, type]);

  return <>
    <div className="rounded-xl border border-[#283748] bg-[#0b141d] p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2"><span className="text-[11px] font-medium text-slate-300">{label}</span>{value ? <button className="text-[10px] text-slate-500 hover:text-rose-300" onClick={() => onChange(null)}>Bỏ chọn</button> : null}</div>
      {value ? <button className="flex w-full items-center gap-3 text-left" onClick={() => { setLoading(true); setOpen(true); }} disabled={disabled}><div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg"><AssetPreview key={value.id} assetId={value.id} status={value.status} alt={value.originalName ?? label} /></div><div className="min-w-0"><p className="truncate text-xs font-medium">{value.originalName}</p><p className="mt-1 text-[10px] text-slate-500">{TYPE_LABELS[value.assetType]}</p><Badge tone="green" className="mt-1">READY</Badge></div></button> : <Button className="w-full" onClick={() => { setLoading(true); setOpen(true); }} disabled={disabled || !projectId}><Images size={15} /> {projectId ? "Chọn từ thư viện" : "Chọn dự án trước"}</Button>}
    </div>
    {open ? <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="asset-picker-title" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <Card className="w-full max-w-3xl p-5 shadow-2xl">
        <div className="flex items-start justify-between"><div><h2 id="asset-picker-title" className="text-lg font-semibold">{label}</h2><p className="mt-1 text-xs text-slate-500">Chỉ hiển thị tài nguyên READY thuộc dự án đang chọn.</p></div><Button variant="ghost" className="h-9 w-9 px-0" onClick={() => setOpen(false)} aria-label="Đóng"><X size={18} /></Button></div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row"><label className="relative flex-1"><span className="sr-only">Tìm tài nguyên</span><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" /><input className="field h-10 pl-9 pr-3 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm tên tệp..." /></label>{allowedTypes.length > 1 ? <select aria-label="Loại tài nguyên" className="field h-10 px-3 text-xs sm:w-48" value={type} onChange={(event) => { setType(event.target.value as AssetType); setPage(1); setLoading(true); }}>{allowedTypes.map((allowed) => <option key={allowed} value={allowed}>{TYPE_LABELS[allowed]}</option>)}</select> : null}</div>
        {error ? <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-200">{error}</p> : null}
        {loading ? <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="aspect-[4/3] animate-pulse rounded-lg bg-slate-800" />)}</div> : null}
        {!loading && !error ? <div className="mt-4 grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4">{items.map((asset) => <button key={asset.id} className="overflow-hidden rounded-lg border border-[#283748] bg-[#0d1720] text-left transition hover:border-blue-400" onClick={() => { onChange(asset); setOpen(false); }}><div className="relative aspect-[4/3]"><AssetPreview assetId={asset.id} status={asset.status} alt={asset.originalName ?? label} /></div><div className="p-2"><p className="truncate text-[11px] font-medium">{asset.originalName}</p><p className="mt-1 text-[9px] text-slate-500">{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "READY"}</p></div></button>)}</div> : null}
        {!loading && !error && items.length === 0 ? <p className="py-12 text-center text-sm text-slate-500">Không có tài nguyên READY phù hợp.</p> : null}
        {pageCount > 1 ? <div className="mt-4 flex items-center justify-between"><span className="text-xs text-slate-500">Trang {page}/{pageCount}</span><div className="flex gap-2"><Button onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }} disabled={page === 1}><ChevronLeft size={14} /></Button><Button onClick={() => { setLoading(true); setPage((value) => Math.min(pageCount, value + 1)); }} disabled={page === pageCount}><ChevronRight size={14} /></Button></div></div> : null}
      </Card>
    </div> : null}
  </>;
}
