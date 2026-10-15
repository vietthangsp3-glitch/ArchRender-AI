"use client";

import { cn } from "@archrender/ui";
import { AlertTriangle, Pause, Play, RotateCcw, Sparkles, Video } from "lucide-react";
import { useEffect, useState } from "react";
import type { AssetSummary, AssetType } from "@/lib/assets/client";
import { AssetPicker } from "./asset-picker";
import { AssetPreview } from "./asset-preview";
import { Badge, Button, Card, SectionTitle } from "./ui";
import { PageHeader } from "./page-header";

const motions = [
  ["Dolly In", "DOLLY_IN"], ["Dolly Out", "DOLLY_OUT"], ["Pan Left", "PAN_LEFT"],
  ["Pan Right", "PAN_RIGHT"], ["Orbit", "ORBIT"], ["Static", "STATIC"],
] as const;

export function VideoStudio({ projectOptions = [] }: { projectOptions?: Array<{ id: string; name: string }> }) {
  const [projectId, setProjectId] = useState("");
  const [source, setSource] = useState<AssetSummary | null>(null);
  const [motion, setMotion] = useState<(typeof motions)[number][1]>("DOLLY_IN");
  const [duration, setDuration] = useState(5);
  const [fps, setFps] = useState(24);
  const [prompt, setPrompt] = useState("slow cinematic camera dolly in, subtle parallax, preserve original architecture, stabilized camera");
  const [playing, setPlaying] = useState(false);
  const [workflowVersionId, setWorkflowVersionId] = useState("");
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; versions: Array<{ id: string; version: number }> }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id?: string; status?: string; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/workflows?kind=IMAGE_TO_VIDEO&status=PUBLISHED").then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.code ?? "Không thể tải workflow.");
      if (active) { setWorkflows(body.workflows); setWorkflowVersionId(body.workflows[0]?.versions[0]?.id ?? ""); }
    }).catch((error: unknown) => { if (active) setResult({ error: error instanceof Error ? error.message : "Không thể tải workflow." }); });
    return () => { active = false; };
  }, []);
  const submit = async () => {
    if (!projectId || !source || !workflowVersionId) return;
    setSubmitting(true); setResult(null);
    try {
      const response = await fetch("/api/render-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey: crypto.randomUUID().replaceAll("-", ""), projectId, workflowVersionId, type: "IMAGE_TO_VIDEO",
        inputs: [{ assetId: source.id, role: "START_FRAME", position: 0 }],
        parameters: { prompt, durationSeconds: duration, fps, motion, quality: "STANDARD" },
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.code ?? "Không thể tạo video job.");
      setResult({ id: body.job.id, status: body.job.status });
    } catch (error) { setResult({ error: error instanceof Error ? error.message : "Không thể tạo video job." }); }
    finally { setSubmitting(false); }
  };
  const risky = motion === "ORBIT";
  return <div className="space-y-5">
    <PageHeader title="AI Video Studio" description="Tạo Render Job image-to-video bền vững; GPU/Wan chưa được gọi trong Milestone 2E." actions={<Button><Video size={15} /> Hướng dẫn video</Button>} />
    <Card className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center"><label className="text-xs text-slate-400">Dự án liên kết <select className="field ml-0 mt-2 h-9 min-w-64 px-3 sm:ml-3 sm:mt-0" value={projectId} onChange={(event) => { setProjectId(event.target.value); setSource(null); setResult(null); }}><option value="">Chưa chọn dự án</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span className="text-[10px] text-slate-600">Chỉ input READY / VERIFIED_IMMUTABLE được chấp nhận.</span></Card>
    <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_330px]">
      <Card className="h-fit p-4"><SectionTitle title="Ảnh đầu vào" /><AssetPicker label="Source / start frame" projectId={projectId} allowedTypes={["SOURCE_IMAGE", "REFERENCE_IMAGE"] as readonly AssetType[]} value={source} onChange={setSource} />
        <label className="mt-4 block text-[11px] text-slate-500">Published workflow<select className="field mt-1.5 h-10 px-3 text-xs" value={workflowVersionId} onChange={(event) => setWorkflowVersionId(event.target.value)}><option value="">Chọn workflow</option>{workflows.flatMap((workflow) => workflow.versions.slice(0, 1).map((version) => <option key={version.id} value={version.id}>{workflow.name} · v{version.version}</option>))}</select></label>
      </Card>
      <Card className="p-4"><SectionTitle title="Xem trước nguồn" action={<Badge>{result?.status ?? "Chưa gửi job"}</Badge>} /><div className="relative aspect-video overflow-hidden rounded-xl bg-black">{source ? <AssetPreview assetId={source.id} status={source.status} alt={source.originalName ?? "Video source"} className={cn("h-full w-full object-cover transition duration-[4000ms]", playing && motion.includes("DOLLY") && "scale-110")} eager /> : <div className="grid h-full place-items-center text-xs text-slate-600">Chọn ảnh từ Asset Library</div>}<button type="button" onClick={() => setPlaying((value) => !value)} className="absolute left-1/2 top-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-black/45 text-white" disabled={!source}>{playing ? <Pause size={22} /> : <Play size={22} />}</button></div>{result ? <div role={result.error ? "alert" : "status"} className={cn("mt-3 rounded-lg border p-3 text-xs", result.error ? "border-red-400/20 bg-red-400/5 text-red-200" : "border-blue-400/20 bg-blue-400/5 text-blue-200")}>{result.error ?? `Job ${result.id} · ${result.status} — chờ render worker.`}</div> : null}</Card>
      <Card className="h-fit p-4 xl:sticky xl:top-[112px]"><SectionTitle title="Điều khiển chuyển động" /><p className="mb-2 text-[11px] text-slate-500">Camera Motion</p><div className="grid grid-cols-2 gap-2">{motions.map(([label, value]) => <button key={value} onClick={() => setMotion(value)} className={cn("rounded-lg border px-2 py-2.5 text-xs", motion === value ? "border-blue-400 bg-blue-400/10 text-blue-200" : "border-[#263648] bg-[#101923] text-slate-400")}>{label}</button>)}</div><div className="mt-5 space-y-4"><label className="block text-xs text-slate-300"><span className="flex justify-between"><span>Thời lượng</span><span>{duration}s</span></span><input className="mt-2 w-full accent-violet-500" type="range" min="1" max="10" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label><label className="block text-[10px] text-slate-500">FPS<select className="field mt-1 h-9 px-2 text-xs" value={fps} onChange={(event) => setFps(Number(event.target.value))}><option value="24">24 FPS</option><option value="30">30 FPS</option></select></label><label className="block text-[11px] text-slate-400">Prompt<textarea className="field mt-1.5 min-h-20 resize-none p-2.5 text-xs" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>{risky ? <div className="flex gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-[11px] text-amber-200"><AlertTriangle size={16} />Orbit từ một ảnh có thể làm biến đổi hình học chưa được nhìn thấy.</div> : null}<Button variant="primary" className="min-h-12 w-full" onClick={submit} disabled={submitting || !projectId || !source || !workflowVersionId || !prompt.trim()}><Sparkles size={18} />{submitting ? "Đang gửi Job…" : "Xếp hàng Video"}</Button><Button className="w-full" onClick={() => { setPlaying(false); setResult(null); }}><RotateCcw size={15} /> Đặt lại</Button></div></Card>
    </div>
  </div>;
}
