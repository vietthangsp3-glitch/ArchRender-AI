"use client";

import { LockKeyhole, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "./ui";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          returnTo,
        }),
      });
      const body = (await response.json()) as { error?: string; redirectTo?: string };
      if (!response.ok) {
        setError(body.error ?? "Không thể đăng nhập lúc này.");
        return;
      }
      router.replace(body.redirectTo ?? "/");
      router.refresh();
    } catch {
      setError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mt-7 space-y-4" onSubmit={submit} noValidate>
      <div>
        <label className="mb-2 block text-xs font-medium text-slate-300" htmlFor="email">
          Email
        </label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={17} />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={320}
            className="field h-11 pl-10 pr-3"
            placeholder="owner@company.com"
          />
        </div>
      </div>
      <div>
        <label className="mb-2 block text-xs font-medium text-slate-300" htmlFor="password">
          Mật khẩu
        </label>
        <div className="relative">
          <LockKeyhole className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={17} />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            className="field h-11 pl-10 pr-3"
            placeholder="Nhập mật khẩu"
          />
        </div>
      </div>
      {error ? (
        <p className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2.5 text-xs text-rose-200" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" className="h-11 w-full" disabled={pending}>
        {pending ? "Đang xác thực…" : "Đăng nhập bảo mật"}
      </Button>
    </form>
  );
}
