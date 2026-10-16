import { LoaderCircle } from "lucide-react";

import { Card } from "@/components/ui";

export default function Loading() {
  return (
    <Card className="flex min-h-48 items-center justify-center p-8 text-sm text-slate-400" role="status">
      <LoaderCircle className="mr-2 animate-spin" size={18} />
      Đang mở lịch sử xử lý…
    </Card>
  );
}
