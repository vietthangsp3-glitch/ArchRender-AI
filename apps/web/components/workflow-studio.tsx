"use client";

import { cn } from "@archrender/ui";
import { Box, CheckCircle2, Plus, Save, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, SectionTitle } from "./ui";
import { PageHeader } from "./page-header";

type Kind = "IMAGE_RENDER" | "IMAGE_UPSCALE" | "IMAGE_TO_VIDEO";
type Configuration = { backend: "COMFYUI_IMAGE" | "WAN_VIDEO"; kind: Kind; parameterSchemaVersion: "1"; modelFamily: string; conditioning: Array<"IMAGE" | "CANNY" | "DEPTH" | "NORMAL"> };
type Workflow = { id: string; name: string; kind: Kind; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; currentVersionNumber: number; draftConfiguration: Configuration; versions: Array<{ id: string; version: number; createdAt: string }> };

const defaults: Record<Kind, Configuration> = {
  IMAGE_RENDER: { backend: "COMFYUI_IMAGE", kind: "IMAGE_RENDER", parameterSchemaVersion: "1", modelFamily: "SDXL", conditioning: ["IMAGE"] },
  IMAGE_UPSCALE: { backend: "COMFYUI_IMAGE", kind: "IMAGE_UPSCALE", parameterSchemaVersion: "1", modelFamily: "SDXL_UPSCALE", conditioning: ["IMAGE"] },
  IMAGE_TO_VIDEO: { backend: "WAN_VIDEO", kind: "IMAGE_TO_VIDEO", parameterSchemaVersion: "1", modelFamily: "WAN", conditioning: ["IMAGE"] },
};
async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.code ?? "Yêu cầu không thành công.");
  return body;
}

export function WorkflowStudio() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [modelFamily, setModelFamily] = useState("");
  const [busy, setBusy] = useState(false);
  const [newKind, setNewKind] = useState<Kind>("IMAGE_RENDER");
  const [error, setError] = useState("");
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const load = useCallback(async () => {
    try {
      const result = await api("/api/workflows");
      setItems(result.workflows);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Không thể tải workflow."); }
  }, []);
  useEffect(() => {
    let active = true;
    void api("/api/workflows").then((result) => {
      if (!active) return;
      const workflows = result.workflows as Workflow[];
      const first = workflows[0];
      setItems(workflows); setSelectedId(first?.id ?? ""); setName(first?.name ?? ""); setModelFamily(first?.draftConfiguration.modelFamily ?? "");
    }).catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Không thể tải workflow."); });
    return () => { active = false; };
  }, []);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await task(); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Thao tác thất bại."); }
    finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const body = await api("/api/workflows", { method: "POST", body: JSON.stringify({ name: `Workflow ${items.length + 1}`, kind: newKind, configuration: defaults[newKind] }) });
      await load(); setSelectedId(body.workflow.id); setName(body.workflow.name); setModelFamily(body.workflow.draftConfiguration.modelFamily);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Không thể tạo workflow."); }
    finally { setBusy(false); }
  };
  const save = () => selected && run(() => api(`/api/workflows/${selected.id}`, { method: "PATCH", body: JSON.stringify({ name, configuration: { ...selected.draftConfiguration, modelFamily } }) }));
  const publish = () => selected && run(() => api(`/api/workflows/${selected.id}/publish`, { method: "POST", body: "{}" }));

  return <div className="space-y-5">
    <PageHeader title="Workflow Studio" description="Workflow configuration được lưu trong PostgreSQL; published versions là immutable và chưa gọi GPU." actions={<><select aria-label="Loại workflow mới" className="field h-9 px-2 text-xs" value={newKind} onChange={(event) => setNewKind(event.target.value as Kind)}><option value="IMAGE_RENDER">Image render</option><option value="IMAGE_UPSCALE">Image upscale</option><option value="IMAGE_TO_VIDEO">Image to video</option></select><Button variant="primary" onClick={create} disabled={busy}><Plus size={15} /> Tạo draft</Button></>} />
    {error ? <div role="alert" className="rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-sm text-red-200">{error}</div> : null}
    <div className="grid min-h-[620px] gap-3 xl:grid-cols-[270px_minmax(0,1fr)_300px]">
      <Card className="p-3"><SectionTitle title="Workflow" /><div className="space-y-2">{items.map((item) => <button key={item.id} onClick={() => { setSelectedId(item.id); setName(item.name); setModelFamily(item.draftConfiguration.modelFamily); }} className={cn("w-full rounded-lg border p-3 text-left", item.id === selectedId ? "border-blue-400/50 bg-blue-400/10" : "border-[#253548] bg-[#0d1620]")}><div className="flex items-center gap-2"><Box size={14} /><span className="truncate text-xs font-medium">{item.name}</span></div><p className="mt-2 text-[10px] text-slate-500">{item.kind} · {item.status} · v{item.currentVersionNumber}</p></button>)}</div>{!items.length ? <p className="rounded-lg border border-dashed border-[#33465a] p-4 text-xs text-slate-500">Chưa có workflow. Tạo draft đầu tiên để bắt đầu.</p> : null}</Card>
      <Card className="p-5"><SectionTitle title="Draft configuration" />{selected ? <div className="space-y-4"><label className="block text-xs text-slate-400">Tên<input className="field mt-1.5 h-10 px-3" value={name} onChange={(event) => setName(event.target.value)} maxLength={180} /></label><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-400">Loại<input className="field mt-1.5 h-10 px-3" value={selected.kind} readOnly /></label><label className="text-xs text-slate-400">Backend<input className="field mt-1.5 h-10 px-3" value={selected.draftConfiguration.backend} readOnly /></label></div><label className="block text-xs text-slate-400">Model family<input className="field mt-1.5 h-10 px-3" value={modelFamily} onChange={(event) => setModelFamily(event.target.value)} maxLength={120} /></label><div className="rounded-xl border border-[#29394b] bg-[#0d1620] p-4 text-xs text-slate-400"><p>Schema version: {selected.draftConfiguration.parameterSchemaVersion}</p><p className="mt-2">Conditioning: {selected.draftConfiguration.conditioning.join(", ")}</p><p className="mt-2">Configuration chỉ là dữ liệu; không chứa script hoặc shell command.</p></div><div className="flex gap-2"><Button onClick={save} disabled={busy || !name.trim() || !modelFamily.trim()}><Save size={15} /> Lưu draft</Button><Button variant="primary" onClick={publish} disabled={busy}><Send size={15} /> Publish version</Button></div></div> : <p className="text-sm text-slate-500">Chọn hoặc tạo workflow.</p>}</Card>
      <Card className="p-4"><SectionTitle title="Published versions" />{selected?.versions.length ? <div className="space-y-2">{selected.versions.map((version) => <div key={version.id} className="rounded-lg border border-emerald-400/15 bg-emerald-400/5 p-3"><div className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 size={14} /> Version {version.version}</div><p className="mt-1 text-[10px] text-slate-500">Immutable · {new Date(version.createdAt).toLocaleString("vi-VN")}</p></div>)}</div> : <p className="text-xs text-slate-500">Chưa publish version nào.</p>}</Card>
    </div>
  </div>;
}
