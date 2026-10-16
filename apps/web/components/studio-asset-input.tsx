"use client";

import { RotateCcw, Square, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { AssetPicker } from "./asset-picker";
import { Badge, Button } from "./ui";

const TYPE_LABELS: Record<UploadAssetType, string> = {
  SOURCE_IMAGE: "Ảnh nguồn",
  REFERENCE_IMAGE: "Ảnh tham chiếu",
  DEPTH_MAP: "Depth Map",
  NORMAL_MAP: "Normal Map",
  CANNY_MAP: "Canny / Lineart",
};

function safeUploadMessage(error: unknown): string {
  if (error instanceof AssetClientError) return assetErrorMessage(error);
  return "Tải trực tiếp thất bại. Hãy kiểm tra kết nối và thử lại.";
}

export function StudioAssetInput({
  label,
  project,
  allowedTypes,
  value,
  policy,
  onChange,
}: {
  label: string;
  project: { id: string; status: "ACTIVE" | "ARCHIVED" } | null;
  allowedTypes: readonly UploadAssetType[];
  value: AssetSummary | null;
  policy: UploadValidationPolicy;
  onChange: (asset: AssetSummary | null) => void;
}) {
  const [uploadType, setUploadType] = useState<UploadAssetType>(allowedTypes[0]!);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => () => controller.current?.abort(), []);

  const upload = async (nextFile: File) => {
    setFile(nextFile);
    setFeedback(null);
    setProgress(0);
    if (!project) {
      setPhase("error");
      setFeedback("Hãy chọn dự án trước khi tải ảnh.");
      return;
    }
    if (project.status !== "ACTIVE") {
      setPhase("error");
      setFeedback("Dự án đã lưu trữ và không thể nhận ảnh mới.");
      return;
    }
    const problem = validateUploadFile(nextFile, policy);
    if (problem) {
      setPhase("error");
      setFeedback(problem);
      return;
    }

    const abortController = new AbortController();
    controller.current = abortController;
    try {
      const asset = await uploadAndVerifyAsset({
        requestId: requestId.current,
        projectId: project.id,
        assetType: uploadType,
        file: nextFile,
        policy,
        signal: abortController.signal,
        onPhase: setPhase,
        onProgress: setProgress,
      });
      onChange(asset);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPhase("cancelled");
        setFeedback("Đã hủy tải lên. Bạn có thể thử lại hoặc chọn từ thư viện.");
      } else {
        if (error instanceof AssetClientError && error.code === "ASSET_UPLOAD_EXPIRED") {
          requestId.current = crypto.randomUUID();
        }
        setPhase("error");
        setFeedback(safeUploadMessage(error));
      }
    } finally {
      controller.current = null;
    }
  };

  const busy = phase === "initiating" || phase === "uploading" || phase === "verifying";
  const cancellable = phase === "initiating" || phase === "uploading";
  const disabled = !project || project.status !== "ACTIVE" || busy;
  const statusLabel = phase === "initiating"
    ? "Đang khởi tạo phiên tải lên…"
    : phase === "uploading"
      ? "Đang tải trực tiếp…"
      : phase === "verifying"
        ? "Đang VERIFYING — chờ xác minh an toàn…"
        : phase === "success"
          ? "Đã xác minh READY và chọn làm input."
          : null;

  return (
    <div className="space-y-2.5">
      <AssetPicker
        label={label}
        projectId={project?.id ?? ""}
        allowedTypes={allowedTypes}
        value={value}
        onChange={onChange}
        disabled={busy}
      />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        {allowedTypes.length > 1 ? (
          <label className="text-[10px] text-slate-500">Loại ảnh tải lên
            <select
              aria-label={`Loại ảnh tải lên cho ${label}`}
              className="field mt-1 h-9 px-2 text-xs"
              value={uploadType}
              onChange={(event) => {
                setUploadType(event.target.value as UploadAssetType);
                setFile(null);
                setPhase("idle");
                setFeedback(null);
                requestId.current = crypto.randomUUID();
              }}
              disabled={busy}
            >
              {allowedTypes.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
            </select>
          </label>
        ) : <span className="self-center text-[10px] text-slate-500">{TYPE_LABELS[uploadType]}</span>}
        <Button onClick={() => inputRef.current?.click()} disabled={disabled} className="self-end">
          <Upload size={14} /> Tải từ máy
        </Button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          aria-label={`Tệp tải lên cho ${label}`}
          accept={policy.acceptedContentTypes.join(",")}
          onChange={(event) => {
            const next = event.target.files?.[0];
            event.currentTarget.value = "";
            if (next) void upload(next);
          }}
        />
      </div>
      {!project ? <p className="text-[10px] text-amber-200">Chọn dự án ACTIVE để tải ảnh từ máy.</p> : null}
      {project?.status === "ARCHIVED" ? <p className="text-[10px] text-amber-200">Dự án đã lưu trữ: chỉ có thể chọn tài nguyên có sẵn.</p> : null}
      {statusLabel ? (
        <div className="rounded-lg border border-blue-400/15 bg-blue-400/5 p-2.5" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-[10px] text-blue-100">
            <span className="min-w-0 truncate">{file?.name} · {statusLabel}</span>
            {phase === "success" ? <Badge tone="green">READY</Badge> : <span>{progress}%</span>}
          </div>
          {busy ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-gradient-to-r from-violet-500 to-blue-400 transition-[width]" style={{ width: `${progress}%` }} /></div> : null}
        </div>
      ) : null}
      {feedback ? <p role="alert" className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-2.5 text-[10px] leading-4 text-amber-100">{feedback}</p> : null}
      {cancellable ? <Button variant="danger" onClick={() => controller.current?.abort()}><Square size={13} /> Hủy tải lên</Button> : null}
      {(phase === "error" || phase === "cancelled") && file && project?.status === "ACTIVE" ? (
        <Button onClick={() => void upload(file)}><RotateCcw size={13} /> Thử lại</Button>
      ) : null}
    </div>
  );
}
