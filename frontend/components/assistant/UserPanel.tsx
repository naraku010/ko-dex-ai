"use client";

import { Settings } from "lucide-react";
import AppMark from "@/components/brand/AppMark";
import { useAuthStore } from "@/store/authStore";

export default function UserPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex items-center gap-2 px-2 py-2" style={{ background: "var(--dc-modifier)" }}>
      <AppMark size={32} variant="avatar" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" style={{ color: "var(--dc-text)" }}>{user.user_name}</p>
        <p className="truncate text-[11px]" style={{ color: "var(--dc-faint)" }}>이 PC에서 사용</p>
      </div>
      <button onClick={onOpenSettings} className="rounded p-1.5" style={{ color: "var(--dc-muted)" }} title="설정">
        <Settings size={16} />
      </button>
    </div>
  );
}
