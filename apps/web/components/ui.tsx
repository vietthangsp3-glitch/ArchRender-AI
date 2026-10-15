import { cn } from "@archrender/ui";
import { X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function Button({ className, variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return (
    <button
      className={cn(
        "inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px] font-medium transition disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#548bff]/60",
        variant === "primary" && "bg-gradient-to-r from-[#8658ff] to-[#3d8dff] text-white shadow-[0_8px_26px_rgba(84,139,255,.22)] hover:brightness-110",
        variant === "secondary" && "border border-[#2a3949] bg-[#17212d] text-slate-200 hover:border-[#3a4b5e] hover:bg-[#1c2a39]",
        variant === "ghost" && "text-slate-300 hover:bg-white/5 hover:text-white",
        variant === "danger" && "border border-rose-400/25 bg-rose-400/10 text-rose-300 hover:bg-rose-400/15",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("panel", className)} {...props} />;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "blue" | "green" | "amber" | "red" | "violet"; className?: string }) {
  const colors = {
    neutral: "border-slate-500/20 bg-slate-500/10 text-slate-300",
    blue: "border-blue-400/20 bg-blue-400/10 text-blue-300",
    green: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    amber: "border-amber-400/20 bg-amber-400/10 text-amber-300",
    red: "border-rose-400/20 bg-rose-400/10 text-rose-300",
    violet: "border-violet-400/20 bg-violet-400/10 text-violet-300",
  };
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", colors[tone], className)}>{children}</span>;
}

export function SectionTitle({ number, title, action }: { number?: number; title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-7 items-center justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-[-0.01em] text-slate-100">{number ? `${number}. ` : ""}{title}</h2>
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cn("relative h-6 w-11 rounded-full border transition", checked ? "border-blue-400/50 bg-blue-500" : "border-slate-600 bg-slate-700")}>
      <span className={cn("absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition", checked ? "left-[20px]" : "left-0.5")} />
    </button>
  );
}

export function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card className="w-full max-w-lg p-5 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" className="h-9 w-9 px-0" onClick={onClose} aria-label="Đóng"><X size={18} /></Button>
        </div>
        {children}
      </Card>
    </div>
  );
}

export function DemoStrip() {
  return (
    <div className="flex items-center gap-2 border-b border-amber-300/10 bg-amber-300/[0.05] px-4 py-2 text-xs text-amber-200/90 lg:px-6">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
      Chế độ Demo Phase 1 — chưa kết nối GPU, ComfyUI hoặc dữ liệu production.
    </div>
  );
}
