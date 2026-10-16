"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { Button, Card } from "@/components/ui";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const digest = error.digest && /^[A-Za-z0-9_-]{1,128}$/.test(error.digest) ? error.digest : "UNAVAILABLE";
    console.error(`[jobs.page] render failed digest=${digest}`);
  }, [error.digest]);

  return (
    <Card className="mx-auto max-w-2xl border-rose-500/30 p-8" role="alert">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 shrink-0 text-rose-300" size={20} />
        <div>
          <h1 className="text-base font-semibold text-slate-100">Không thể mở lịch sử xử lý</h1>
          <p className="mt-2 text-sm text-slate-400">Phiên làm việc hoặc dịch vụ dữ liệu có thể tạm thời không khả dụng. Hãy thử tải lại trang.</p>
          <Button className="mt-4" onClick={reset}><RefreshCw size={14} /> Thử lại</Button>
        </div>
      </div>
    </Card>
  );
}
