"use client";
import { Button, Card } from "@/components/ui";
export default function ErrorState({ reset }: { reset: () => void }) { return <Card className="grid min-h-72 place-items-center p-8 text-center"><div><h2 className="font-semibold">Không thể tải danh sách dự án</h2><p className="mt-2 text-xs text-slate-500">Kết nối dữ liệu gặp sự cố tạm thời.</p><Button className="mt-4" onClick={reset}>Thử lại</Button></div></Card>; }
