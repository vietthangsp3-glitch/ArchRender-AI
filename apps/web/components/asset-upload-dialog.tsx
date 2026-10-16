"use client";

import { CloudUpload, FileImage, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AssetClientError,
  assetErrorMessage,
  type AssetSummary,
  type UploadAssetType,
} from "@/lib/assets/client";
import {
  uploadAndVerifyAsset,
  validateUploadFile,
  type UploadPhase,
  type UploadValidationPolicy,
} from "@/lib/assets/upload";
import { Badge, Button, Card } from "./ui";

const TYPE_LABELS: Record<UploadAssetType, string> = {
  SOURCE_IMAGE: "Ảnh nguồn",
  REFERENCE_IMAGE: "Ảnh tham chiếu",
  DEPTH_MAP: "Depth Map",
  NORMAL_MAP: "Normal Map",
  CANNY_MAP: "Canny Map",
};

export function AssetUploadDialog({
  open,
  projects,
  policy,
  onClose,
  onUploaded,
}: {
  open: boolean;
  projects: Array<{ id: string; name: string; status: "ACTIVE" | "ARCHIVED" }>;
  policy: UploadValidationPolicy;
  onClose: () => void;
  onUploaded: (asset: AssetSummary) => void;
}) {
  const activeProjects = useMemo(
    () => projects.filter((project) => project.status === "ACTIVE"),
    [projects],
  );
  const [projectId, setProjectId] = useState(() => activeProjects[0]?.id ?? "");
  const [assetType, setAssetType] = useState<UploadAssetType>("SOURCE_IMAGE");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const selectFile = (next: File | undefined) => {
    if (!next) return;
    const problem = validateUploadFile(next, policy);
    if (problem) {
      setFeedback(problem);
      return;
    }
    setFile(next);
    setFeedback(null);
    setProgress(0);
    setPhase("idle");
    requestId.current = crypto.randomUUID();
  };

  const upload = async () => {
    if (!file || !projectId || phase === "uploading" || phase === "verifying") return;
    const problem = validateUploadFile(file, policy);
    if (problem) return setFeedback(problem);
    const abortController = new AbortController();
    controller.current = abortController;
    setFeedback(null);
    setProgress(0);
    try {
      const asset = await uploadAndVerifyAsset({
        requestId: requestId.current,
        projectId,
        assetType,
        file,
        policy,
        signal: abortController.signal,
        onPhase: setPhase,
        onProgress: setProgress,
      });
      onUploaded(asset);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPhase("cancelled");
        setFeedback("Đã hủy. Bản ghi chờ sẽ được tác vụ bảo trì dọn sau khi hết hạn.");
      } else {
        if (error instanceof AssetClientError && error.code === "ASSET_UPLOAD_EXPIRED") {
          requestId.current = crypto.randomUUID();
        }
        setPhase("error");
        setFeedback(assetErrorMessage(error));
      }
    } finally {
      controller.current = null;
    }
  };

  const cancel = () => controller.current?.abort();
  const close = () => {
    cancel();
    onClose();
  };

  if (!open) return null;
  const busy = phase === "initiating" || phase === "uploading" || phase === "verifying";
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="asset-upload-title"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}
    >
      <Card className="w-full max-w-xl p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="asset-upload-title" className="text-lg font-semibold">Tải tài nguyên</h2>
            <p className="mt-1 text-xs text-slate-500">Tệp chỉ được đánh dấu READY sau khi server xác minh.</p>
          </div>
          <Button variant="ghost" className="h-9 w-9 px-0" onClick={close} aria-label="Đóng" disabled={busy}>
            <X size={18} />
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">Dự án ACTIVE
            <select className="field mt-1.5 h-10 px-3 text-xs" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={busy}>
              <option value="">Chọn dự án</option>
              {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">Loại tài nguyên
            <select className="field mt-1.5 h-10 px-3 text-xs" value={assetType} onChange={(event) => setAssetType(event.target.value as UploadAssetType)} disabled={busy}>
              {policy.uploadAssetTypes.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
            </select>
          </label>
        </div>

        <div
          className="mt-4 flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed border-[#314257] bg-[#0b141d] p-5 text-center"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); if (!busy) selectFile(event.dataTransfer.files[0]); }}
        >
          {file ? <FileImage size={30} className="text-blue-300" /> : <CloudUpload size={32} className="text-blue-300" />}
          <p className="mt-3 max-w-full truncate text-sm font-medium">{file?.name ?? "Kéo thả ảnh vào đây"}</p>
          <p className="mt-1 text-[11px] text-slate-500">JPG, PNG, WebP · tối đa {Math.floor(policy.maxUploadBytes / 1024 / 1024)} MB</p>
          <Button className="mt-3" onClick={() => inputRef.current?.click()} disabled={busy}>Chọn tệp</Button>
          <input ref={inputRef} className="sr-only" type="file" accept={policy.acceptedContentTypes.join(",")} onChange={(event) => selectFile(event.target.files?.[0])} />
        </div>

        {busy || phase === "success" ? (
          <div className="mt-4" aria-live="polite">
            <div className="flex justify-between text-xs"><span>{phase === "verifying" ? "Đang xác minh an toàn…" : phase === "success" ? "Đã xác minh READY" : "Đang tải trực tiếp lên R2…"}</span><span>{progress}%</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-gradient-to-r from-violet-500 to-blue-400 transition-[width]" style={{ width: `${progress}%` }} /></div>
          </div>
        ) : null}
        {feedback ? <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200" role="alert">{feedback}</p> : null}
        {phase === "success" ? <div className="mt-3"><Badge tone="green">READY</Badge></div> : null}

        <div className="mt-5 flex justify-end gap-2">
          {phase === "initiating" || phase === "uploading" ? <Button variant="danger" onClick={cancel}><Square size={14} /> Hủy tải lên</Button> : null}
          {phase === "error" || phase === "cancelled" ? <Button onClick={upload} disabled={!file || !projectId}><RotateCcw size={14} /> Thử lại</Button> : null}
          {phase === "success" ? <Button onClick={close}>Đóng</Button> : (
            <Button variant="primary" onClick={upload} disabled={!file || !projectId || busy}>Tải lên và xác minh</Button>
          )}
        </div>
      </Card>
    </div>
  );
}
