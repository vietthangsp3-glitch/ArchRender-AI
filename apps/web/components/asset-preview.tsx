"use client";

import { ImageOff, LoaderCircle, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { assetErrorMessage, getAssetThumbnailUrl, type AssetStatus } from "@/lib/assets/client";

export function AssetPreview({
  assetId,
  status,
  alt,
  className = "h-full w-full object-cover",
  eager = false,
  variant,
}: {
  assetId: string;
  status: AssetStatus;
  alt: string;
  className?: string;
  eager?: boolean;
  variant?: "grid" | "detail";
}) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [source, setSource] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [loading, setLoading] = useState(status === "READY");
  const [error, setError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const resolvedVariant = variant ?? (eager ? "detail" : "grid");

  useEffect(() => {
    if (eager || !host.current || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    if (!visible || status !== "READY") return;
    const controller = new AbortController();
    getAssetThumbnailUrl(assetId, resolvedVariant, controller.signal)
      .then((result) => {
        setError(null);
        setSource(result.url);
        setExpiresAt(new Date(result.expiresAt).getTime());
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(assetErrorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [assetId, refreshes, status, resolvedVariant, visible]);

  const handleImageError = useCallback(() => {
    if (refreshes === 0 && Date.now() >= expiresAt - 5_000) {
      setSource(null);
      setLoading(true);
      setRefreshes(1);
      return;
    }
    setError("Không thể tải bản xem trước an toàn.");
    setSource(null);
  }, [expiresAt, refreshes]);

  return (
    <div ref={host} className="relative h-full w-full bg-[#0a121a]">
      {source ? (
        // Signed R2 URLs are short-lived and intentionally bypass the Next image proxy/cache.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt={alt} className={className} loading={eager ? "eager" : "lazy"} onError={handleImageError} />
      ) : null}
      {loading ? <div className="absolute inset-0 grid place-items-center text-slate-500"><LoaderCircle className="animate-spin" size={22} /></div> : null}
      {!loading && status !== "READY" ? <div className="absolute inset-0 grid place-items-center text-slate-600"><ImageOff size={24} /></div> : null}
      {error ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-[10px] text-amber-200"><ShieldAlert size={22} /><span>{error}</span></div> : null}
    </div>
  );
}
