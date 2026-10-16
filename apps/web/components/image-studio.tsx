"use client";

import { cn } from "@archrender/ui";
import { motion } from "motion/react";
import {
  ChevronDown,
  CircleHelp,
  Crop,
  Info,
  Layers3,
  Maximize2,
  SlidersHorizontal,
  WandSparkles,
  Zap,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AssetSummary, UploadAssetType } from "@/lib/assets/client";
import type { UploadValidationPolicy } from "@/lib/assets/upload";
import { archImages } from "@/lib/mock-data";
import { AssetPreview } from "./asset-preview";
import { StudioAssetInput } from "./studio-asset-input";
import { Badge, Button, Card, SectionTitle, Toggle } from "./ui";
import { PageHeader } from "./page-header";

const styles = ["Hiện đại", "Tối giản", "Wabi Sabi", "Indochine", "Luxury", "Scandinavian", "Công nghiệp", "Nhiệt đới"];
const presets = ["Phong cách", "Ánh sáng", "Vật liệu", "Môi trường", "Nâng cao"];

function Segmented<T extends string>({ items, value, onChange }: { items: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => <button key={item} type="button" onClick={() => onChange(item)} className={cn("rounded-lg border px-3 py-2 text-xs transition", value === item ? "border-blue-400 bg-blue-400/10 text-blue-200 shadow-[0_0_0_1px_rgba(84,139,255,.25)]" : "border-[#233244] bg-[#111b27] text-slate-400 hover:text-slate-200")}>{item}</button>)}
    </div>
  );
}

function ComparePreview({ source }: { source: AssetSummary | null }) {
  const [position, setPosition] = useState(53);
  return (
    <div className="group relative aspect-[16/8.6] min-h-[170px] overflow-hidden rounded-xl bg-[#091019] sm:min-h-[220px]">
      <Image src={archImages[0]} fill alt="Kết quả AI Render Demo" className="object-cover" sizes="(max-width: 1024px) 100vw, 42vw" loading="eager" />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${position}%` }}>
        <div className="relative h-full" style={{ width: `${10000 / position}%` }}>{source ? <AssetPreview assetId={source.id} status={source.status} alt={source.originalName ?? "Render gốc"} className="h-full w-full object-cover grayscale-[45%] brightness-75" eager /> : <Image src={archImages[4]} fill alt="Render gốc Demo" className="object-cover grayscale-[45%] brightness-75" sizes="(max-width: 1024px) 100vw, 42vw" />}</div>
      </div>
      <div className="absolute inset-y-0 w-0.5 bg-white/80 shadow-xl" style={{ left: `${position}%` }}><div className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-slate-900 shadow-xl">↔</div></div>
      <input aria-label="So sánh trước và sau" className="absolute inset-0 h-full w-full cursor-col-resize opacity-0" type="range" min="10" max="90" value={position} onChange={(event) => setPosition(Number(event.target.value))} />
      <Badge className="absolute left-3 top-3 border-0 bg-black/60 text-white">Trước · Render thô</Badge>
      <Badge className="absolute right-3 top-3 border-0 bg-black/60 text-white">Sau · AI Render</Badge>
      <div className="absolute bottom-3 right-3 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <Button className="h-8 w-8 px-0" aria-label="Vừa màn hình"><Crop size={14} /></Button>
        <Button className="h-8 w-8 px-0" aria-label="Toàn màn hình" onClick={() => document.documentElement.requestFullscreen?.()}><Maximize2 size={14} /></Button>
      </div>
    </div>
  );
}

function Range({ label, value, min = 0, max = 1, step = 0.05, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="block"><span className="mb-1.5 flex justify-between text-xs text-slate-300"><span>{label}</span><span className="rounded bg-[#1a2735] px-1.5 py-0.5 text-slate-200">{value}</span></span><input className="h-1.5 w-full accent-[#6b7cff]" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function ImageStudio({ projectOptions = [], uploadPolicy }: {
  projectOptions?: Array<{ id: string; name: string; status: "ACTIVE" | "ARCHIVED" }>;
  uploadPolicy: UploadValidationPolicy;
}) {
  const [projectId, setProjectId] = useState("");
  const [source, setSource] = useState<AssetSummary | null>(null);
  const [controlAsset, setControlAsset] = useState<AssetSummary | null>(null);
  const [controlType, setControlType] = useState<"DEPTH_MAP" | "NORMAL_MAP" | "CANNY_MAP">("DEPTH_MAP");
  const [selectedStyle, setSelectedStyle] = useState("Hiện đại");
  const [activePreset, setActivePreset] = useState("Phong cách");
  const [resolution, setResolution] = useState<"1080p" | "2K" | "4K">("4K");
  const [preserve, setPreserve] = useState(0.8);
  const [details, setDetails] = useState(0.6);
  const [depth, setDepth] = useState(true);
  const [normal, setNormal] = useState(true);
  const [tiled, setTiled] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [workflowVersionId, setWorkflowVersionId] = useState("");
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; versions: Array<{ id: string; version: number }> }>>([]);
  const [prompt, setPrompt] = useState("Biệt thự hiện đại hai tầng, vật liệu bê tông và gỗ, ánh sáng chiều hoàng hôn, hồ bơi, cây xanh, architectural photography");
  const [negativePrompt, setNegativePrompt] = useState("low quality, blurry, distorted, changed structure, cartoon, illustration, people, text, watermark");
  const [submission, setSubmission] = useState<{ id?: string; status?: string; error?: string } | null>(null);
  const selectedProject = projectOptions.find((project) => project.id === projectId);
  const archivedProject = selectedProject?.status === "ARCHIVED";

  useEffect(() => {
    let active = true;
    fetch("/api/workflows?kind=IMAGE_RENDER&status=PUBLISHED").then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.code ?? "Không thể tải workflow.");
      if (active) { setWorkflows(body.workflows); setWorkflowVersionId(body.workflows[0]?.versions[0]?.id ?? ""); }
    }).catch((error: unknown) => { if (active) setSubmission({ error: error instanceof Error ? error.message : "Không thể tải workflow." }); });
    return () => { active = false; };
  }, []);
  const startRender = async () => {
    if (!source || !projectId || !workflowVersionId || archivedProject) return;
    setSubmitting(true); setSubmission(null);
    const [width, height] = resolution === "4K" ? [3840, 2160] : resolution === "2K" ? [2560, 1440] : [1920, 1080];
    try {
      const response = await fetch("/api/render-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey: crypto.randomUUID().replaceAll("-", ""), projectId, workflowVersionId, type: "IMAGE_RENDER",
        inputs: [{ assetId: source.id, role: "SOURCE_IMAGE", position: 0 }, ...(controlAsset ? [{ assetId: controlAsset.id, role: "CONTROL_IMAGE", position: 1 }] : [])],
        parameters: { prompt, negativePrompt, strength: preserve, steps: 30, guidance: Math.max(1, Math.round(details * 10)), width, height },
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.code ?? "Không thể tạo render job.");
      setSubmission({ id: body.job.id, status: body.job.status });
    } catch (error) { setSubmission({ error: error instanceof Error ? error.message : "Không thể tạo render job." }); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="AI Image Studio" description="Biến bản vẽ, render thô hoặc mô hình 3D thành hình ảnh kiến trúc photorealistic 4K với AI." actions={<><Button><CircleHelp size={15} /> Hướng dẫn</Button><Button><Layers3 size={15} /> Workflow mẫu</Button><Button onClick={() => setAdvanced((value) => !value)}><SlidersHorizontal size={15} /> Tùy chỉnh nâng cao</Button></>} />

      <Card className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center"><label className="text-xs text-slate-400">Dự án liên kết <select className="field ml-0 mt-2 h-9 min-w-64 px-3 sm:ml-3 sm:mt-0" value={projectId} onChange={(event) => { setProjectId(event.target.value); setSource(null); setControlAsset(null); setSubmission(null); }}><option value="">Chưa chọn dự án</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}{project.status === "ARCHIVED" ? " · lưu trữ" : ""}</option>)}</select></label><span className="text-[10px] text-slate-600">Chỉ VERIFIED_IMMUTABLE assets được dùng làm render input.</span>{archivedProject ? <Badge tone="amber">Chỉ đọc</Badge> : null}</Card>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {["Render kiến trúc", "Interior", "Exterior", "Biến thể thiết kế", "Phong cách nghệ thuật"].map((tab, index) => <button key={tab} className={cn("shrink-0 rounded-lg border px-5 py-2.5 text-xs font-medium transition", index === 0 ? "border-blue-400/50 bg-gradient-to-r from-[#7b68ff] to-[#4b9cff] text-white" : "border-[#273545] bg-[#121b25] text-slate-300 hover:bg-[#182330]")}>{tab}</button>)}
      </div>

      <div className="grid gap-3 xl:grid-cols-[0.92fr_1.05fr_1.45fr]">
        <Card className="p-3.5"><SectionTitle number={1} title="Chọn ảnh đầu vào" /><StudioAssetInput key={`source-${selectedProject?.id ?? "none"}`} label="Ảnh nguồn / tham chiếu" project={selectedProject ?? null} allowedTypes={["SOURCE_IMAGE", "REFERENCE_IMAGE"] as readonly UploadAssetType[]} value={source} policy={uploadPolicy} onChange={setSource} /><p className="mt-3 text-[11px] leading-5 text-slate-500">Ảnh phải thuộc dự án đang chọn và đã hoàn tất xác minh READY.</p></Card>

        <Card className="p-3.5">
          <SectionTitle number={2} title="Bản đồ điều khiển" action={<Badge>Tùy chọn</Badge>} />
          <div className="mb-3 grid grid-cols-3 gap-1.5 rounded-lg bg-[#0c141d] p-1">{[["DEPTH_MAP", "Depth Map"], ["NORMAL_MAP", "Normal Map"], ["CANNY_MAP", "Canny / Lineart"]].map(([value, item]) => <button key={value} onClick={() => { setControlType(value as typeof controlType); setControlAsset(null); }} className={cn("rounded-md py-2 text-[11px] transition", controlType === value ? "border border-blue-400 bg-blue-400/10 text-blue-200" : "text-slate-400 hover:text-slate-200")}>{item}</button>)}</div>
          <StudioAssetInput key={`control-${selectedProject?.id ?? "none"}-${controlType}`} label={controlType === "DEPTH_MAP" ? "Depth Map" : controlType === "NORMAL_MAP" ? "Normal Map" : "Canny Map"} project={selectedProject ?? null} allowedTypes={[controlType]} value={controlAsset} policy={uploadPolicy} onChange={setControlAsset} />
          <p className="mt-3 text-[11px] leading-5 text-slate-500">Control map là tùy chọn và phải thuộc cùng dự án với ảnh nguồn.</p>
        </Card>

        <Card className="p-3.5"><SectionTitle number={3} title="Xem trước và so sánh" action={<span className="text-[11px] text-slate-500">3840 × 2160 · Demo</span>} /><ComparePreview source={source} /></Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_286px]">
        <Card className="overflow-hidden p-3.5">
          <SectionTitle number={4} title="Chọn phong cách và thiết lập" />
          <div className="mb-3 flex gap-1 overflow-x-auto rounded-lg bg-[#0c141d] p-1">{presets.map((preset) => <button key={preset} onClick={() => setActivePreset(preset)} className={cn("min-w-[100px] flex-1 rounded-md px-3 py-2 text-xs transition", activePreset === preset ? "border border-blue-400 bg-blue-400/10 text-blue-200" : "text-slate-400 hover:bg-white/5")}>{preset}</button>)}</div>
          <div className="mb-3 grid grid-cols-4 gap-2 md:grid-cols-8">{styles.map((style, index) => <button key={style} onClick={() => setSelectedStyle(style)} className={cn("overflow-hidden rounded-lg border text-left transition", selectedStyle === style ? "border-blue-400 shadow-[0_0_0_1px_rgba(84,139,255,.3)]" : "border-[#233141] hover:border-[#3d5269]")}><div className="relative aspect-[4/3]"><Image src={archImages[index % archImages.length]!} fill alt={style} className="object-cover" sizes="150px" /></div><div className="truncate bg-[#101923] px-2 py-1.5 text-center text-[10px] text-slate-300">{style}</div></button>)}</div>
          <div className="grid gap-3 lg:grid-cols-[0.9fr_1fr_1.2fr]">
            <div className="rounded-xl border border-[#223142] bg-[#0e1720] p-3">
              <h3 className="mb-3 text-xs font-semibold">Thông số render</h3>
              <p className="mb-1.5 text-[11px] text-slate-500">Độ phân giải</p><Segmented items={["1080p", "2K", "4K"] as const} value={resolution} onChange={setResolution} />
              <p className="mb-1.5 mt-3 text-[11px] text-slate-500">Tỷ lệ khung hình</p><button className="field flex h-9 items-center justify-between px-3 text-xs">16:9 (Phong cảnh) <ChevronDown size={14} /></button>
              <p className="mb-1.5 mt-3 text-[11px] text-slate-500">Số ảnh tạo ra</p><div className="field flex h-9 items-center px-3 text-xs">1 output / job</div>
            </div>
            <div className="space-y-4 rounded-xl border border-[#223142] bg-[#0e1720] p-3">
              <Range label="Giữ nguyên kiến trúc" value={preserve} onChange={setPreserve} />
              <Range label="Tăng cường chi tiết" value={details} onChange={setDetails} />
              {[{ label: "Dùng Depth Map (ControlNet)", value: depth, set: setDepth }, { label: "Dùng Normal Map", value: normal, set: setNormal }, { label: "Tiled Upscale (tiết kiệm VRAM)", value: tiled, set: setTiled }].map((item) => <div key={item.label} className="flex items-center justify-between gap-3 text-[11px] text-slate-300"><span>{item.label}</span><Toggle label={item.label} checked={item.value} onChange={item.set} /></div>)}
            </div>
            <div className="space-y-3 rounded-xl border border-[#223142] bg-[#0e1720] p-3">
              <label className="block text-[11px] font-medium text-slate-300">Prompt<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="field mt-1.5 min-h-[82px] resize-none p-2.5 text-xs leading-5" /></label>
              <label className="block text-[11px] font-medium text-slate-300">Negative Prompt<textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} className="field mt-1.5 min-h-[62px] resize-none p-2.5 text-xs leading-5" /></label>
            </div>
          </div>
          {advanced ? <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="mt-3 grid gap-3 overflow-hidden rounded-xl border border-violet-400/20 bg-violet-400/[0.035] p-3 sm:grid-cols-3 lg:grid-cols-6">{[["Seed", "12345"], ["Steps", "30"], ["CFG", "5.5"], ["Denoise", "0.26"], ["Canny", "0.65"], ["Depth", "0.78"]].map(([label, value]) => <label key={label} className="text-[10px] text-slate-500">{label}<input className="field mt-1 h-9 px-2 text-xs" defaultValue={value} /></label>)}</motion.div> : null}
        </Card>

        <Card className="h-fit p-3.5 xl:sticky xl:top-[112px]">
          <SectionTitle number={5} title="GPU & Workflow" />
          <p className="text-[11px] text-slate-500">GPU hiện tại</p>
          <div className="mt-1.5 flex items-center gap-3 rounded-xl border border-[#2b3c4e] bg-[#0d1720] p-3"><div className="grid h-10 w-10 place-items-center rounded-lg bg-lime-400/10 text-lime-400"><Zap size={21} /></div><div><div className="text-sm font-semibold">RTX 4090 <Badge tone="amber" className="ml-1">Demo</Badge></div><div className="mt-1 text-[11px] text-emerald-400">● Trạng thái mô phỏng</div></div></div>
          <label className="mt-4 block text-[11px] text-slate-500">Published workflow<select className="field mt-1.5 h-10 px-2 text-xs" value={workflowVersionId} onChange={(event) => setWorkflowVersionId(event.target.value)}><option value="">Chọn workflow</option>{workflows.flatMap((workflow) => workflow.versions.slice(0, 1).map((version) => <option key={version.id} value={version.id}>{workflow.name} · v{version.version}</option>))}</select></label>
          <div className="mt-3 rounded-xl border border-[#263648] bg-[#0d1720] p-3"><div className="flex gap-3"><Info size={17} className="mt-0.5 text-slate-400" /><div><p className="text-[11px] text-slate-500">Execution backend</p><p className="mt-1 text-sm font-semibold">Chưa kết nối GPU</p><p className="mt-1 text-[11px] text-slate-500">Job được lưu bền vững và chờ worker.</p></div></div></div>
          {submission ? <div role={submission.error ? "alert" : "status"} className={cn("mt-3 rounded-xl border p-3 text-xs", submission.error ? "border-red-400/20 bg-red-400/5 text-red-200" : "border-blue-400/20 bg-blue-400/5 text-blue-200")}>{submission.error ?? `Job ${submission.id} · ${submission.status} — chờ render worker.`}</div> : null}
          <Button variant="primary" className="mt-3 min-h-12 w-full text-sm" onClick={startRender} disabled={submitting || !source || !workflowVersionId || !prompt.trim() || archivedProject}><WandSparkles size={18} />{archivedProject ? "Dự án chỉ đọc" : submitting ? "Đang gửi Job…" : "Xếp hàng Render"}</Button>
          <Link href="/workflow-studio"><Button className="mt-2 w-full"><Layers3 size={15} /> Mở Workflow Studio</Button></Link>
          <p className="mt-3 text-center text-[10px] leading-4 text-slate-600">Không gọi GPU thật. Thời gian và chi phí chỉ là minh họa.</p>
        </Card>
      </div>

      <Card className="p-3.5"><SectionTitle title="Kết quả render" /><p className="rounded-lg border border-dashed border-[#33465a] p-6 text-center text-sm text-slate-500">Milestone 2E không tạo output giả. Theo dõi lifecycle thật trong Lịch sử xử lý; output assets sẽ do worker tương lai đính kèm.</p></Card>
    </div>
  );
}
